import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EnterpriseAssetStoreError } from "../enterprise-assets/contract.js";
import { readHostSkillPolicy } from "../enterprise-assets/hostBackendAssets.js";
import {
  UWorkBackendSessionError,
  type UWorkBackendSession,
} from "../enterprise-identity/backendSessionContract.js";

export interface SkillAccess {
  checkpoint(): Promise<void>;
  io<T>(work: () => Promise<T>): Promise<T>;
}

export function isSkillAccessError(
  error: unknown,
): error is EnterpriseAssetStoreError | UWorkBackendSessionError {
  return error instanceof EnterpriseAssetStoreError || error instanceof UWorkBackendSessionError;
}

export function skillIO<T>(access: SkillAccess | undefined, work: () => Promise<T>): Promise<T> {
  return access ? access.io(work) : work();
}

function readWork<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}

/** 整次技能调用复用同一准入；身份/config 唯一 owner 仍是既有私有 backendSession。 */
export async function withPersonalSkillAccess<T>(
  backendSession: UWorkBackendSession | undefined,
  work: (access?: SkillAccess) => Promise<T>,
  options: {
    failureCode?:
      | "enterprise_skill_sync_failed"
      | "enterprise_skill_read_failed"
      | "enterprise_skill_management_failed";
    readWork?: boolean;
  } = {},
): Promise<T> {
  if (!backendSession) return work();
  const traceId = randomUUID();
  let result: { managed: false } | { managed: true; value: T };
  try {
    result = await backendSession.run(
      async (scope) => {
        const checkpoint = async () => {
          const policy = await readHostSkillPolicy(scope);
          await scope.assertCurrent();
          if (!policy.allowFilesystem)
            throw new EnterpriseAssetStoreError("enterprise_filesystem_denied");
          if (!policy.personalSkills || !policy.dangerousSkills)
            throw new EnterpriseAssetStoreError("enterprise_personal_skills_denied");
        };
        const access: SkillAccess = {
          checkpoint,
          async io(operation) {
            await checkpoint();
            try {
              return await operation();
            } finally {
              // 普通 FS 失败也要重验，不能被 metadata fallback / failedCount 吞掉撤权。
              await checkpoint();
            }
          },
        };
        await checkpoint();
        // 正文出口保留原取消race；写操作必须等物理IO落定，不能提前释放原writeQueue。
        const value = options.readWork
          ? await readWork(() => work(access), scope.signal)
          : await work(access);
        // run 的末尾只校验 identity/config；mixed 最后一个非技能等待后也必须重读策略。
        await checkpoint();
        return value;
      },
      { traceId, signal: AbortSignal.timeout(70000) },
    );
  } catch (error) {
    const code =
      isSkillAccessError(error) && /^enterprise_[a-z_]{1,64}$/.test(error.code)
        ? error.code
        : (options.failureCode ?? "enterprise_skill_sync_failed");
    throw new EnterpriseAssetStoreError(code, traceId);
  }
  return result.managed ? result.value : work();
}

/** cp 的内部异步读写无法逐次准入；受管 Copy 在同一 scope 下显式读后重验、写前准入。 */
export async function copyManagedSkillDirectory(
  sourcePath: string,
  targetPath: string,
  access: SkillAccess,
): Promise<void> {
  const source = await access.io(() => lstat(sourcePath));
  if (source.isSymbolicLink()) {
    const linkTarget = await access.io(() => readlink(sourcePath));
    await access.io(() => symlink(resolve(dirname(sourcePath), linkTarget), targetPath));
    return;
  }
  if (source.isDirectory()) {
    const canonicalSource = await access.io(() => realpath(sourcePath));
    const canonicalParent = await access.io(() => realpath(dirname(targetPath)));
    const targetWithinSource = relative(
      canonicalSource,
      join(canonicalParent, basename(targetPath)),
    );
    // 保留 cp 的自复制拒绝边界；storage override 或父目录软链不能让递归读到刚写入的自身。
    if (
      targetWithinSource === "" ||
      (!isAbsolute(targetWithinSource) &&
        targetWithinSource !== ".." &&
        !targetWithinSource.startsWith(`..${sep}`))
    )
      throw new Error("settings_sync_skill_copy_into_source");
    await access.io(() => mkdir(targetPath));
    const entries = await access.io(() => readdir(sourcePath));
    for (const entry of entries) {
      await copyManagedSkillDirectory(join(sourcePath, entry), join(targetPath, entry), access);
    }
  } else if (source.isFile()) {
    const content = await access.io(() => readFile(sourcePath));
    await access.io(() => writeFile(targetPath, content, { flag: "wx", mode: source.mode }));
  } else {
    throw new Error("settings_sync_skill_file_type_unsupported");
  }
  // mkdir/writeFile 受 umask 影响；与既有 cp 一样在复制完成后还原源 mode。
  await access.io(() => chmod(targetPath, source.mode));
}
