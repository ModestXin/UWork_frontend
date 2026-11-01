import { join } from "node:path";
import {
  enterpriseAdmissionAssetSchema,
  enterpriseAssetReferenceSchema,
  enterpriseSkillsCatalogSchema,
  type EnterpriseAdmissionAsset,
  type EnterpriseSkillsCatalog,
  type ZCodeEnterpriseToolAuthorizationResult,
} from "@zcode/shared";
import {
  UWorkBackendSessionError,
  type UWorkBackendScope,
  type UWorkBackendSession,
} from "../enterprise-identity/backendSessionContract.js";
import {
  assetKey,
  digest,
  EnterpriseAssetStoreError,
  parseAssetPackage,
  type EnterpriseAssetBinding,
  type EnterpriseAssetOperation,
} from "./assetPackage.js";
import { createEnterpriseAssetStore } from "./assetStore.js";
import type { EnterpriseAssetStore, EnterpriseAssetStoreEvent } from "./contract.js";
import type { EnterpriseAssetsHost } from "./hostContract.js";
import {
  authorizeHostAsset,
  downloadHostAsset,
  readHostAssetManifest,
  readHostSkillPolicy,
} from "./hostBackendAssets.js";

function safeCode(error: unknown): string {
  return (error instanceof EnterpriseAssetStoreError ||
    error instanceof UWorkBackendSessionError) &&
    /^enterprise_[a-z_]{1,64}$/.test(error.code)
    ? error.code
    : "enterprise_assets_unavailable";
}
const deny = (code: string): ZCodeEnterpriseToolAuthorizationResult => ({ allowed: false, code });
/** 连接器没有落盘对象：只按目录绑定与后端当前准入判断。 */
function isConnectorAsset(
  binding: EnterpriseAdmissionAsset | EnterpriseAssetBinding | undefined,
): binding is { asset: { id: string; kind: "connector"; version: number; checksum: string } } {
  if (!binding || typeof binding !== "object" || !("asset" in binding)) return false;
  const asset = (binding as { asset?: { kind?: string } }).asset;
  return asset?.kind === "connector";
}

export function createEnterpriseAssetsHost(options: {
  backendSession: UWorkBackendSession;
  storageDirectory: string;
  onCacheEvent?: (event: EnterpriseAssetStoreEvent) => void;
}): EnterpriseAssetsHost {
  const stores = new Map<string, EnterpriseAssetStore>();
  const catalogTails = new Map<EnterpriseAssetStore, Promise<void>>();
  const controllers = new Set<AbortController>(),
    pending = new Set<Promise<unknown>>();
  let disposed = false;
  const storeFor = (scope: UWorkBackendScope) => {
    // 一个 profile 一个缓存根：选择代次覆盖当前可下发的全部类型，
    // 不能按类型分根，否则一次 reconcile 会剪掉另一个类型仍在用的对象。
    const key = digest(JSON.stringify([scope.origin, scope.tenantId, scope.memberId]));
    let store = stores.get(key);
    if (!store) {
      store = createEnterpriseAssetStore({
        root: join(options.storageDirectory, `enterprise-assets-${key}`),
        onEvent: options.onCacheEvent,
      });
      stores.set(key, store);
    }
    return store;
  };
  const owned = <T>(
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (disposed)
      return Promise.reject(new EnterpriseAssetStoreError("enterprise_assets_disposed"));
    const controller = new AbortController();
    controllers.add(controller);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(() => {
      combined.throwIfAborted();
      return operation(combined);
    });
    pending.add(task);
    return task.finally(() => {
      controllers.delete(controller);
      pending.delete(task);
    });
  };
  const catalogTransaction = <T>(
    store: EnterpriseAssetStore,
    scope: UWorkBackendScope,
    parent: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (disposed || scope.signal.aborted)
      return Promise.reject(new UWorkBackendSessionError("enterprise_authorization_cancelled"));
    const previous = catalogTails.get(store) ?? Promise.resolve();
    const task = previous.then(async () => {
      // 原 scope 必须在出队前仍有效；不能用排队后的新身份执行旧请求。
      scope.signal.throwIfAborted();
      await scope.assertCurrent();
      scope.signal.throwIfAborted();
      return operation();
    });
    const tail = task.then(
      () => {},
      () => {},
    );
    catalogTails.set(store, tail);
    void tail.then(() => {
      if (catalogTails.get(store) === tail) catalogTails.delete(store);
    });
    // 调用方取消有界返回，但内部 slot 仍等前驱结束，不能让后继越过正在执行的事务。
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        scope.signal.removeEventListener("abort", abort);
        reject(
          new UWorkBackendSessionError(
            parent.aborted ? "enterprise_authorization_cancelled" : "enterprise_identity_changed",
          ),
        );
      };
      scope.signal.addEventListener("abort", abort, { once: true });
      if (scope.signal.aborted) abort();
      void task.then(
        (value) => {
          scope.signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          scope.signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  };
  return {
    async readCatalog(traceId, signal): Promise<EnterpriseSkillsCatalog> {
      try {
        return await owned(signal, async (parent) => {
          const result = await options.backendSession.run(
            async (scope) => {
              const store = storeFor(scope);
              // Native 后台预热与首次 runtime 不能互相退休 selection；跨 Host 的磁盘 CAS 原样保留。
              return catalogTransaction(store, scope, parent, async () => {
                const operation = { traceId, signal: scope.signal, isCurrent: scope.isCurrent };
                const revision = await store.readSelectionRevision(operation);
                const policy = await readHostSkillPolicy(scope),
                  manifest = await readHostAssetManifest(scope);
                const authorized = [];
                for (const item of manifest.assets)
                  if (await authorizeHostAsset(scope, item)) authorized.push(item);
                const connectors = [];
                for (const item of manifest.connectors)
                  if (await authorizeHostAsset(scope, item))
                    connectors.push({
                      asset: {
                        id: item.id,
                        kind: "connector" as const,
                        version: item.version,
                        checksum: item.checksum,
                      },
                      name: item.name,
                      distributed: item.distributed,
                    });
                const selected = await store.select(revision, authorized.map(assetKey), operation);
                const assets = [],
                  experts = [];
                for (const item of authorized) {
                  const key = assetKey(item);
                  let reference;
                  try {
                    reference = await store.verify(key, operation);
                  } catch (error) {
                    if (
                      !(error instanceof EnterpriseAssetStoreError) ||
                      error.code !== "enterprise_asset_not_cached"
                    )
                      throw error;
                    const downloaded = parseAssetPackage(await downloadHostAsset(scope, item));
                    if (assetKey(downloaded) !== key)
                      throw new EnterpriseAssetStoreError("enterprise_assets_changed");
                    reference = await store.materialize(downloaded, operation);
                  }
                  await scope.assertCurrent();
                  if (!(await authorizeHostAsset(scope, item)))
                    throw new EnterpriseAssetStoreError("enterprise_assets_changed");
                  if (item.kind === "skill")
                    assets.push({
                      ...reference,
                      asset: { ...reference.asset, kind: "skill" as const },
                      name: item.name,
                      distributed: item.distributed,
                    });
                  else
                    experts.push({
                      ...reference,
                      asset: { ...reference.asset, kind: "expert" as const },
                      name: item.name,
                      distributed: item.distributed,
                    });
                }
                if (
                  JSON.stringify(await readHostAssetManifest(scope)) !== JSON.stringify(manifest) ||
                  JSON.stringify(await readHostSkillPolicy(scope)) !== JSON.stringify(policy)
                )
                  throw new EnterpriseAssetStoreError("enterprise_assets_changed");
                await store.select(
                  selected,
                  [...assets, ...experts].map((item) => item.key),
                  operation,
                );
                return enterpriseSkillsCatalogSchema.parse({
                  status: "ready",
                  ownerKey: scope.ownerKey,
                  ...policy,
                  assets,
                  experts,
                  connectors,
                });
              });
            },
            { signal: parent, traceId },
          );
          return result.managed ? result.value : { status: "unmanaged" };
        });
      } catch (error) {
        return { status: "denied", code: safeCode(error) };
      }
    },
    async authorizeAsset(
      reference: EnterpriseAdmissionAsset | undefined,
      traceId,
      signal,
      expectedOwnerKey,
    ) {
      try {
        return await owned(signal, async (parent) => {
          const result = await options.backendSession.run(
            async (scope) => {
              if (expectedOwnerKey !== undefined && expectedOwnerKey !== scope.ownerKey)
                return deny("enterprise_identity_changed");
              const policy = await readHostSkillPolicy(scope);
              // 连接器没有本地字节：不适用文件系统策略，也没有可校验的缓存对象，
              // 当前准入完全由后端按目录绑定判定。
              const connector = isConnectorAsset(reference);
              if (!connector && !policy.allowFilesystem)
                return deny("enterprise_filesystem_denied");
              if (reference === undefined)
                return policy.personalSkills && policy.dangerousSkills
                  ? { allowed: true, code: "allowed" }
                  : deny("enterprise_personal_skills_denied");
              const admission = enterpriseAdmissionAssetSchema.safeParse(
                connector
                  ? { asset: reference.asset }
                  : {
                      key: (reference as { key?: string }).key,
                      asset: reference.asset,
                      directory: (reference as { directory?: string }).directory,
                    },
              );
              if (!admission.success) return deny("enterprise_assets_invalid");
              if (isConnectorAsset(admission.data)) {
                if (!(await authorizeHostAsset(scope, admission.data.asset)))
                  return deny("enterprise_asset_denied");
                return { allowed: true, code: "allowed" };
              }
              const parsed = enterpriseAssetReferenceSchema.parse(admission.data);
              if (assetKey(parsed.asset) !== parsed.key) return deny("enterprise_assets_invalid");
              if (!(await authorizeHostAsset(scope, parsed.asset)))
                return deny("enterprise_asset_denied");
              const verified = await storeFor(scope).verify(parsed.key, {
                traceId,
                signal: scope.signal,
                isCurrent: scope.isCurrent,
              });
              if (
                verified.directory !== parsed.directory ||
                assetKey(verified.asset) !== parsed.key ||
                verified.asset.kind !== parsed.asset.kind
              )
                return deny("enterprise_asset_scope_mismatch");
              if (!(await authorizeHostAsset(scope, verified.asset)))
                return deny("enterprise_asset_denied");
              const latest = await readHostSkillPolicy(scope);
              if (!latest.allowFilesystem) return deny("enterprise_filesystem_denied");
              // 校验后撤销危险技能策略不能被旧的资产允许结果覆盖。
              if (JSON.stringify(latest) !== JSON.stringify(policy))
                return deny("enterprise_assets_changed");
              return { allowed: true, code: "allowed" };
            },
            { signal: parent, traceId },
          );
          return result.managed ? result.value : { allowed: true, code: "not_managed" };
        });
      } catch (error) {
        return deny(safeCode(error));
      }
    },
    async clearCached(operation: EnterpriseAssetOperation) {
      await owned(operation.signal, async (signal) => {
        for (const store of stores.values()) {
          await store.prune([], { ...operation, signal });
        }
      });
    },
    async disposeAllAndWait() {
      disposed = true;
      for (const controller of controllers) controller.abort("disposed");
      await Promise.allSettled([...pending, ...catalogTails.values()]);
      catalogTails.clear();
      stores.clear();
    },
  };
}
