import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withFileLock } from "@zcode/shared/node";
import { z } from "zod";
import {
  assetBinding,
  assetFiles,
  assetKey,
  assertCurrent,
  digest,
  EnterpriseAssetStoreError,
  MAX_ASSET_BYTES,
  parseAssetPackage,
  type EnterpriseAssetOperation,
  type EnterpriseAssetReference,
} from "./assetPackage.js";
import {
  assertDirectory,
  assertExactTree,
  assertOptionalLock,
  assertRootPath,
  hasCode,
  readBoundedFile,
} from "./assetStoreFs.js";
import type { EnterpriseAssetStore, EnterpriseAssetStoreEvent } from "./contract.js";
import { advanceSelection, readSelection, SELECTION_FILE } from "./assetSelection.js";

const OWNER_FILE = ".owner.json";
const STAGE_FILE = ".ownership.json";
const MANIFEST_FILE = "manifest.json";
const CONTENT_DIRECTORY = "content";
const MAX_ROOT_ENTRIES = 1024;
const MAX_METADATA_BYTES = 4096;
const KEY = /^[a-f0-9]{64}$/;
const STAGE = /^stage-[a-f0-9-]{36}$/;
const ownerSchema = z
  .object({ format: z.literal("uwork.enterprise-assets/v1"), owner: z.uuid() })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal("uwork.enterprise-asset/v1"),
    key: z.string().regex(KEY),
    asset: z.unknown(),
  })
  .strict();

export function createEnterpriseAssetStore(options: {
  root: string;
  onEvent?: (event: EnterpriseAssetStoreEvent) => void;
}): EnterpriseAssetStore {
  const root = resolve(options.root);
  if (!isAbsolute(options.root) || dirname(root) === root)
    throw new EnterpriseAssetStoreError("enterprise_asset_path_unsafe");
  const lockTarget = join(dirname(root), `.enterprise-assets-${digest(root)}`);
  let owner: string | undefined;
  const ensureRoot = async () => {
    await assertRootPath(dirname(root));
    let created = false;
    try {
      await mkdir(root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    await assertRootPath(root);
    if (created)
      await writeFile(
        join(root, OWNER_FILE),
        JSON.stringify({ format: "uwork.enterprise-assets/v1", owner: randomUUID() }),
        { flag: "wx", mode: 0o600 },
      );
    const record = ownerSchema.parse(
      JSON.parse(
        (await readBoundedFile(join(root, OWNER_FILE), MAX_METADATA_BYTES)).toString("utf8"),
      ),
    );
    if (owner !== undefined && owner !== record.owner)
      throw new EnterpriseAssetStoreError("enterprise_asset_owner_changed");
    owner = record.owner;
  };
  const readObject = async (key: string) => {
    if (!KEY.test(key)) throw new EnterpriseAssetStoreError("enterprise_asset_invalid");
    await assertRootPath(root);
    const object = join(root, key);
    try {
      await assertDirectory(object);
    } catch (error) {
      if (hasCode(error, "ENOENT"))
        throw new EnterpriseAssetStoreError("enterprise_asset_not_cached");
      throw error;
    }
    const ownership = ownerSchema.parse(
      JSON.parse(
        (await readBoundedFile(join(object, STAGE_FILE), MAX_METADATA_BYTES)).toString("utf8"),
      ),
    );
    if (ownership.owner !== owner)
      throw new EnterpriseAssetStoreError("enterprise_asset_owner_changed");
    const manifest = manifestSchema.parse(
      JSON.parse(
        (await readBoundedFile(join(object, MANIFEST_FILE), MAX_ASSET_BYTES * 2)).toString("utf8"),
      ),
    );
    const asset = parseAssetPackage(manifest.asset);
    if (manifest.key !== key || assetKey(asset) !== key)
      throw new EnterpriseAssetStoreError("enterprise_asset_checksum");
    const top = await readdir(object);
    if (
      top.length !== 3 ||
      !top.includes(STAGE_FILE) ||
      !top.includes(MANIFEST_FILE) ||
      !top.includes(CONTENT_DIRECTORY)
    )
      throw new EnterpriseAssetStoreError("enterprise_asset_tree_unsafe");
    const directory = join(object, CONTENT_DIRECTORY);
    return { key, asset, directory };
  };
  const verify = async (
    key: string,
    operation: EnterpriseAssetOperation,
  ): Promise<EnterpriseAssetReference> => {
    assertCurrent(operation);
    const reference = await readObject(key);
    await assertExactTree(reference.directory, assetFiles(reference.asset));
    assertCurrent(operation);
    return { key, asset: assetBinding(reference.asset), directory: reference.directory };
  };
  const cleanStages = async () => {
    const names = await readdir(root);
    if (names.length > MAX_ROOT_ENTRIES)
      throw new EnterpriseAssetStoreError("enterprise_asset_limit");
    for (const name of names) {
      if (name === OWNER_FILE) continue;
      if (name === SELECTION_FILE) {
        await readSelection(root, owner!);
        continue;
      }
      if (KEY.test(name)) {
        await readObject(name);
        continue;
      }
      if (!STAGE.test(name)) throw new EnterpriseAssetStoreError("enterprise_asset_tree_unsafe");
      const path = join(root, name);
      await assertDirectory(path);
      const marker = ownerSchema.parse(
        JSON.parse(
          (await readBoundedFile(join(path, STAGE_FILE), MAX_METADATA_BYTES)).toString("utf8"),
        ),
      );
      if (marker.owner !== owner)
        throw new EnterpriseAssetStoreError("enterprise_asset_owner_changed");
      await rm(path, { recursive: true });
    }
  };
  const locked = async <T>(
    operation: EnterpriseAssetOperation,
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      assertCurrent(operation);
      await assertRootPath(dirname(root));
      // 通用锁支持清理 stale owner，调用前必须拒绝指向个人目录的替代锁及未知条目。
      await assertOptionalLock(`${lockTarget}.lock`);
      return await withFileLock(lockTarget, async () => {
        await ensureRoot();
        assertCurrent(operation);
        await cleanStages();
        assertCurrent(operation);
        return work();
      });
    } catch (error) {
      if (error instanceof EnterpriseAssetStoreError) throw error;
      throw new EnterpriseAssetStoreError("enterprise_asset_storage_unavailable");
    }
  };
  const observed = async <T>(
    name: EnterpriseAssetStoreEvent["operation"],
    operation: EnterpriseAssetOperation,
    work: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now(),
      traceId = operation.traceId;
    const traced = typeof traceId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(traceId);
    let code: string | undefined;
    try {
      if (!traced) throw new EnterpriseAssetStoreError("enterprise_asset_trace_required");
      return await work();
    } catch (error) {
      code =
        error instanceof EnterpriseAssetStoreError
          ? error.code
          : "enterprise_asset_storage_unavailable";
      throw new EnterpriseAssetStoreError(code, traced ? traceId : undefined);
    } finally {
      // 观测出口不能改变已提交的缓存结果，且只传固定字段，不传正文、路径或所有权凭据。
      if (traced)
        try {
          options.onEvent?.({
            event: "enterprise.asset.cache",
            traceId,
            operation: name,
            status: code ? "failed" : "succeeded",
            durationMs: Math.max(0, Date.now() - startedAt),
            ...(code ? { code } : {}),
          });
        } catch {
          /* 日志 sink 失败不重新执行文件写入。 */
        }
    }
  };
  const select = (
    keepKeys: readonly string[],
    operation: EnterpriseAssetOperation,
    expectedRevision?: string | null,
  ): Promise<string> => {
    if (keepKeys.some((key) => !KEY.test(key)))
      return Promise.reject(new EnterpriseAssetStoreError("enterprise_asset_invalid"));
    const keep = new Set(keepKeys);
    return locked(operation, async () => {
      // 先比较跨窗口的磁盘代次，旧同步不能清理较新任务已经返回的目录。
      if (
        expectedRevision !== undefined &&
        (await readSelection(root, owner!)) !== expectedRevision
      )
        throw new EnterpriseAssetStoreError("enterprise_asset_selection_changed");
      const keys = (await readdir(root)).filter((key) => KEY.test(key));
      for (const key of keys) await verify(key, operation);
      const revision = await advanceSelection(root, owner!, operation);
      for (const key of keys)
        if (!keep.has(key)) {
          await assertRootPath(root);
          assertCurrent(operation);
          await rm(join(root, key), { recursive: true });
        }
      return revision;
    });
  };
  return {
    readSelectionRevision(operation) {
      return observed("revision", operation, () =>
        locked(operation, () => readSelection(root, owner!)),
      );
    },
    select(expectedRevision, keepKeys, operation) {
      return observed("select", operation, () => select(keepKeys, operation, expectedRevision));
    },
    async materialize(
      input: unknown,
      operation: EnterpriseAssetOperation,
    ): Promise<EnterpriseAssetReference> {
      return observed("materialize", operation, async () => {
        const asset = parseAssetPackage(input),
          key = assetKey(asset);
        return locked(operation, async () => {
          const destination = join(root, key);
          try {
            await lstat(destination);
            return verify(key, operation);
          } catch (error) {
            if (!hasCode(error, "ENOENT")) throw error;
          }
          const stage = join(root, `stage-${randomUUID()}`);
          await mkdir(stage, { mode: 0o700 });
          const created = await lstat(stage);
          const marker = JSON.stringify({ format: "uwork.enterprise-assets/v1", owner });
          let outcome:
            | { success: true; reference: EnterpriseAssetReference }
            | { success: false; error: unknown };
          try {
            await writeFile(join(stage, STAGE_FILE), marker, { flag: "wx", mode: 0o600 });
            const directory = join(stage, CONTENT_DIRECTORY);
            await mkdir(directory, { mode: 0o700 });
            for (const file of assetFiles(asset)) {
              assertCurrent(operation);
              const path = join(directory, ...file.path.split("/"));
              await mkdir(dirname(path), { recursive: true, mode: 0o700 });
              await assertDirectory(dirname(path));
              await writeFile(path, file.content, { flag: "wx", mode: 0o600 });
            }
            await assertExactTree(directory, assetFiles(asset));
            await writeFile(
              join(stage, MANIFEST_FILE),
              JSON.stringify({ format: "uwork.enterprise-asset/v1", key, asset }),
              { flag: "wx", mode: 0o600 },
            );
            await assertRootPath(root);
            assertCurrent(operation);
            await rename(stage, destination);
            outcome = { success: true, reference: await verify(key, operation) };
          } catch (error) {
            outcome = { success: false, error };
          }
          try {
            await assertRootPath(root);
            const remaining = await lstat(stage);
            if (
              remaining.isSymbolicLink() ||
              remaining.ino !== created.ino ||
              remaining.dev !== created.dev
            )
              throw new EnterpriseAssetStoreError("enterprise_asset_owner_changed");
            const currentOwner = ownerSchema.parse(
              JSON.parse(
                (await readBoundedFile(join(root, OWNER_FILE), MAX_METADATA_BYTES)).toString(
                  "utf8",
                ),
              ),
            );
            if (currentOwner.owner !== owner)
              throw new EnterpriseAssetStoreError("enterprise_asset_owner_changed");
            await rm(stage, { recursive: true });
          } catch (error) {
            if (!hasCode(error, "ENOENT")) {
              if (!outcome.success)
                throw new EnterpriseAssetStoreError("enterprise_asset_cleanup_unconfirmed");
              throw error;
            }
          }
          if (!outcome.success) throw outcome.error;
          return outcome.reference;
        });
      });
    },
    verify(key: string, operation: EnterpriseAssetOperation): Promise<EnterpriseAssetReference> {
      return observed("verify", operation, () => locked(operation, () => verify(key, operation)));
    },
    prune(keepKeys: readonly string[], operation: EnterpriseAssetOperation): Promise<void> {
      return observed("prune", operation, async () => {
        await select(keepKeys, operation);
      });
    },
  };
}
