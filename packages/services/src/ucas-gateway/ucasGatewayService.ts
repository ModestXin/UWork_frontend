import {
  createGatewayProjectionAdmission,
  createGatewayReadOperation,
  type GatewayProjectionScope,
} from "./gatewayProjectionAdmission.js";
import { Emitter } from "@zcode/rpc";
import {
  createGatewayCatalogLifecycle,
  gatewayCatalogAuthority,
  type GatewayCatalogLifecycleAuthority,
} from "./gatewayCatalogLifecycle.js";
import {
  ucasGatewayViewSchema,
  type UcasGatewayError,
  type UcasGatewaySyncResult,
  type UcasGatewayUsageRequest,
  type UcasGatewayView,
} from "@zcode/shared";
import type { IUcasGatewayService, UcasGatewayProvisioningTarget } from "./contract.js";
import type { UcasGatewayStore } from "./ucasGatewayStore.js";
import {
  createGatewayIdentityScopeFactory,
  createScopedGatewayClient,
  isGatewayProjectionCurrent,
  type GatewayIdentityScope,
  type GatewayIdentitySource,
} from "./gatewayIdentityScope.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { IdentitySessionStore } from "../enterprise-identity/identitySessionStore.js";
import {
  createGatewayIdentitySource,
  createGatewayWriteAdmission,
} from "./gatewayWriteAdmission.js";
import {
  resolveGatewayEndpoint as resolveEndpoint,
  ensureGatewayKey as ensureKey,
  readGatewayPlanModels as readPlanModels,
  readGatewayModelApplication,
  readGatewayAccountStats,
  classifyGatewayFailure,
  applyCurrentGatewayCatalog,
} from "./gatewayProvisioningReads.js";
import {
  uncommittedGatewayResult,
  initialGatewayView,
  hydratedGatewayProjection,
  failedGatewayProjection,
  refreshedUsageProjection,
  committedGatewayResult,
  readyGatewayProjection,
  emptyGatewayProjection,
  appliedModelsProjection,
  modelCatalogProjection,
} from "./gatewayViewProjection.js";


import type { UcasGatewayServiceOptions } from "./gatewayWriteAdmission.js";
export type { UcasGatewayServiceOptions } from "./gatewayWriteAdmission.js";

export function createUcasGatewayService(
  options: UcasGatewayServiceOptions,
): IUcasGatewayService & {
  dispose(): void;
  disposeAll(): void;
  readonly [gatewayCatalogAuthority]: GatewayCatalogLifecycleAuthority;
} {
  const log = createServiceLogger("ucas-gateway");
  const now = options.now ?? Date.now;
  const identitySource = createGatewayIdentitySource(options);
  const changed = new Emitter<UcasGatewayView>();
  let disposed = false;
  const createScope = createGatewayIdentityScopeFactory(identitySource, () => disposed);
  let hydrated = false;
  let syncTask: Promise<UcasGatewaySyncResult> | null = null;
  let usageSerial = 0;
  let projectedScope: GatewayIdentityScope | null = null;
  let view = initialGatewayView();

  const publish = (next: Omit<UcasGatewayView, "revision">): void => {
    if (disposed) return;
    const parsed = ucasGatewayViewSchema.safeParse({
      ...next,
      revision: view.revision + 1,
    });
    if (!parsed.success) {
      // 视图是不可信外部数据的投影；不合格的字段宁可丢弃也不能进入 Renderer。
      log.warn(undefined, "UCAS gateway view was rejected by its schema");
      return;
    }
    view = parsed.data;
    changed.fire(structuredClone(view));
  };
  const hydrate = async (): Promise<void> => {
    if (hydrated) return;
    hydrated = true;
    try {
      const state = await options.store.read();
      const authMode =
        (await options.resolveBackend?.()) === "uwork" ? "enterprise-session" : undefined;
      view = { ...view, authMode };
      if (state) publish(hydratedGatewayProjection(view, state));
    } catch {
      log.warn(undefined, "UCAS gateway state was not readable; continuing without it");
    }
  };
  const errorCode = (error: unknown): UcasGatewayError => {
    const failure = classifyGatewayFailure(error);
    options.onDiagnostic?.(failure);
    log.warn(undefined, "UCAS gateway request failed", failure);
    return failure.code;
  };
  const failureView = (error: unknown, backend: string, partial = false) =>
    failedGatewayProjection(view, errorCode(error), backend === "uwork", partial);
  const signedOutResult = () => uncommittedGatewayResult(view);
  const clearIdentityProjection = (invalidScope?: GatewayIdentityScope) => {
    // 旧操作不能清掉新owner已提交的视图；失效投影才移除全部身份派生数据。
    if (
      projectedScope?.managed &&
      projectedScope.isCurrent() &&
      projectedScope.signal !== invalidScope?.signal
    )
      return;
    const managed = projectedScope?.managed || invalidScope?.managed;
    projectedScope = null;
    publish(
      emptyGatewayProjection(
        view,
        options.readIdentityAuthority?.()?.session ? "idle" : "signed-out",
        !!managed,
      ),
    );
    catalog.notify();
  };
  const admission = createGatewayProjectionAdmission({
    provisioning: options.provisioning,
    clearProjection: clearIdentityProjection,
    publishFailure: (error, backend, partial) => publish(failureView(error, backend, partial)),
    onRejection: () => {
      usageSerial++;
      projectedScope = null;
      catalog.notify();
    },
    onClearFailure: () => log.warn(undefined, "Rejected Gateway candidates could not be cleared"),
  });
  const catalog = createGatewayCatalogLifecycle({
    ...identitySource,
    isProjectedCurrent: () => !!projectedScope?.managed && projectedScope.isCurrent(),
    hasManagedProjection: () => !!projectedScope?.managed || view.authMode === "enterprise-session",
    invalidateProjection: () => clearIdentityProjection(),
    advance: () => admission.advance(),
    isCurrentGeneration: (generation) => admission.isCurrent(generation),
    onClearFailure: () =>
      log.warn(undefined, "Revoked managed Gateway catalog could not be cleared"),
  });
  const { admitWrite, readIdentityRecord } = createGatewayWriteAdmission(
    options.identitySessionStore,
    () => disposed,
    now,
  );
  const runSync = async (reason: string, generation: number): Promise<UcasGatewaySyncResult> => {
    await hydrate();
    const session = await identitySource.readIdentitySession();
    if (!session) {
      projectedScope = null;
      clearIdentityProjection();
      return signedOutResult();
    }
    const identityRecord = await readIdentityRecord();
    const apiBaseUrl = await options.resolveApiBaseUrl();
    if (!apiBaseUrl) {
      publish({ ...view, status: "idle", configured: false, error: "unconfigured" });
      return signedOutResult();
    }
    const backend = (await options.resolveBackend?.()) ?? "ucas";
    if (backend === "uwork" && !admission.isCurrent(generation)) return signedOutResult();
    const authMode = backend === "uwork" ? "enterprise-session" : undefined;
    publish({ ...view, status: "syncing", configured: true, error: null, authMode });
    let scope: GatewayProjectionScope | undefined;
    try {
      scope = admission.bind(createScope(session, apiBaseUrl, backend), generation);
      catalog.watch(scope);
      await admission.prepare(scope, projectedScope, view.endpoint?.baseUrl, apiBaseUrl);
      const client = createScopedGatewayClient(identitySource, session, apiBaseUrl, backend, scope);
      const user = await client.readProfile();
      await scope.assertCurrent();
      const keyInfo = await ensureKey(client, scope.managed);
      await scope.assertCurrent();
      const endpoint = resolveEndpoint(await client.readGatewayEndpoints());
      await scope.assertCurrent();
      const plan = await readPlanModels(client, endpoint, keyInfo.apiKey);
      await scope.assertCurrent();
      const applied = await admitWrite(identityRecord, () =>
        options.provisioning.apply({
          baseUrl: endpoint.baseUrl,
          ...(scope!.managed
            ? { authMode: "enterprise-session" as const }
            : { apiKey: keyInfo.apiKey }),
          ...(!scope!.managed && (reason === "replace-key" || client.issueDeviceCredential)
            ? { replaceApiKey: true }
            : {}),
          modelIds: plan.ids,
          ...(scope!.managed ? { isCurrent: scope!.isCurrent } : {}),
          ...(plan.descriptors ? { managedModels: plan.descriptors } : {}),
        }),
      );
      await scope.assertCurrent();
      if (!applied) return signedOutResult();
      // Provider 确认写入后才吊销旧凭据，查询/写入失败不能破坏原本可用的配置。
      if (client.retireDeviceCredential && view.key && view.key.id !== keyInfo.key?.id)
        await client
          .retireDeviceCredential(view.key.id)
          .catch(() => log.warn(undefined, "Previous device credential could not be retired"));
      await scope.assertCurrent();
      const { subscriptions, usage } = await readGatewayAccountStats(
        client,
        view.usage,
        scope.managed,
      );
      await scope.assertCurrent();
      const lastSyncedAt = now();
      await options.store
        .write({
          version: 1,
          userId: user.id,
          orgId: user.orgId,
          endpoint,
          key: keyInfo.key,
          lastSyncedAt,
        })
        .catch(() => log.warn(undefined, "UCAS gateway state was not persisted"));
      await scope.assertCurrent();
      if (!scope.isCurrent()) return signedOutResult();
      projectedScope = scope.identityScope;
      catalog.notify();
      publish(
        readyGatewayProjection(
          view,
          {
            user,
            endpoint,
            key: keyInfo.key,
            subscriptions,
            usage,
            lastSyncedAt,
            authMode: scope.managed ? "enterprise-session" : undefined,
          },
          plan,
        ),
      );
      log.info(undefined, "UCAS gateway provisioning synced", {
        reason,
        endpoint: endpoint.source,
        authMode: scope.managed ? "enterprise-session" : keyInfo.reused ? "reused" : "generated",
      });
      return committedGatewayResult(view, applied, keyInfo.reused);
    } catch (error) {
      await admission.fail(error, scope, apiBaseUrl, backend);
      return signedOutResult();
    }
  };
  const serializeSync = (reason: string): Promise<UcasGatewaySyncResult> => {
    const generation = admission.advance();
    const previous = syncTask ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => (disposed ? signedOutResult() : runSync(reason, generation)));
    syncTask = task;
    const cleanup = () => {
      if (syncTask === task) syncTask = null;
    };
    void task.then(cleanup, cleanup);
    return task;
  };
  const withSession = createGatewayReadOperation({
    source: identitySource,
    hydrate,
    readView: () => view,
    readScope: () => projectedScope,
    signedOut: () => {
      projectedScope = null;
      clearIdentityProjection();
    },
    clearProjection: clearIdentityProjection,
    publish,
    createScope,
    admission,
  });

  return {
    [gatewayCatalogAuthority]: catalog.authority,
    onDidChange: changed.event,
    async getView() {
      await hydrate();
      const inspectedScope = projectedScope;
      const session = await identitySource.readIdentitySession();
      if (
        inspectedScope?.managed &&
        !(await isGatewayProjectionCurrent(
          inspectedScope,
          view.endpoint?.baseUrl,
          await options.resolveApiBaseUrl(),
        )) &&
        projectedScope === inspectedScope
      )
        clearIdentityProjection(inspectedScope);
      if (projectedScope !== inspectedScope) return structuredClone(view);
      if (!session && view.status !== "signed-out") {
        projectedScope = null;
        publish(emptyGatewayProjection(view, "signed-out"));
      } else if (session && view.status === "signed-out") {
        const configured = Boolean(await options.resolveApiBaseUrl());
        publish({ ...view, status: "idle", configured });
      }
      return structuredClone(view);
    },
    sync(reason) {
      return serializeSync(reason);
    },
    refreshUsage(request: UcasGatewayUsageRequest) {
      // 服务端统计是慢聚合：连续切换周期/指标时，响应可能乱序返回。
      // 只接受最后一次请求的结果，避免旧周期数据把新选择覆盖回去（界面表现为来回闪动）。
      const serial = ++usageSerial;
      return withSession(
        async (client, scope) => {
          const facts = scope.managed
            ? await readGatewayAccountStats(client, request, true)
            : { usage: await client.readUsage(request) };
          await scope.assertCurrent();
          if (serial !== usageSerial || !scope.isCurrent()) return;
          publish(refreshedUsageProjection(view, facts));
        },
        () => serial === usageSerial,
      );
    },
    async refreshModels() {
      return withSession(async (client, scope) => {
        await hydrate();
        const identityRecord = await readIdentityRecord();
        const endpoint = view.endpoint;
        if (!endpoint && !scope.managed) return;
        const plan = await client.readPlanModels();
        if (scope.managed && endpoint && view.user)
          await admitWrite(identityRecord, () =>
            applyCurrentGatewayCatalog(options.provisioning, scope, endpoint, plan),
          );
        const local = new Set(await options.provisioning.listModels());
        await scope.assertCurrent();
        if (scope.isCurrent()) publish(modelCatalogProjection(view, plan, local));
      });
    },
    async applyModels() {
      await hydrate();
      const session = await identitySource.readIdentitySession();
      if (!session) {
        projectedScope = null;
        clearIdentityProjection();
        return signedOutResult();
      }
      const apiBaseUrl = await options.resolveApiBaseUrl();
      if (!apiBaseUrl) return signedOutResult();
      const backend = (await options.resolveBackend?.()) ?? "ucas";
      const identityRecord = await readIdentityRecord();
      let scope: GatewayProjectionScope | undefined;
      try {
        scope = admission.bind(createScope(session, apiBaseUrl, backend));
        await scope.assertCurrent();
        const endpoint = view.endpoint,
          ids = view.models?.available ?? [];
        const currentProjection =
          !scope.managed ||
          (await isGatewayProjectionCurrent(projectedScope, endpoint?.baseUrl, apiBaseUrl));
        // 模型缓存是投影，不是写权限；换用户/组织后重新走同一同步owner获取目录。
        if (
          !endpoint ||
          !currentProjection ||
          ids.length === 0 ||
          (scope.managed &&
            (view.user?.id !== session.profile.id || view.user.orgId !== session.profile.tenantId))
        )
          return serializeSync("models");
        const models = await readGatewayModelApplication(
          scope.managed
            ? createScopedGatewayClient(identitySource, session, apiBaseUrl, backend, scope)
            : undefined,
          ids,
        );
        await scope.assertCurrent();
        const applied = await admitWrite(identityRecord, () =>
          options.provisioning.apply({
            baseUrl: endpoint.baseUrl,
            modelIds: models.ids,
            ...(scope!.managed ? { isCurrent: scope!.isCurrent } : {}),
            ...(scope!.managed ? { authMode: "enterprise-session" as const } : {}),
            ...(models.descriptors ? { managedModels: models.descriptors } : {}),
          }),
        );
        await scope.assertCurrent();
        if (!applied) return signedOutResult();
        if (!scope.isCurrent()) return signedOutResult();
        projectedScope = scope.identityScope;
        publish(appliedModelsProjection(view, models.ids));
        return committedGatewayResult(view, applied, false, true);
      } catch (error) {
        await admission.fail(error, scope, apiBaseUrl, backend, true);
        return signedOutResult();
      }
    },
    replaceApiKey() {
      return serializeSync("replace-key");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      catalog.dispose();
      changed.dispose();
    },
    disposeAll() {
      disposed = true;
      catalog.dispose();
      changed.dispose();
    },
  };
}
