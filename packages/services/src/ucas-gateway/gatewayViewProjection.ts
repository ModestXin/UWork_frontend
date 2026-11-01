import {
  ucasGatewayModelsSchema,
  ucasGatewaySyncResultSchema,
  type UcasGatewaySyncResult,
  type UcasGatewayError,
  type UcasGatewayView,
} from "@zcode/shared";

interface AppliedProvisioning {
  apiKeyApplied: boolean;
  hasApiKey: boolean;
  modelsAdded: number;
  modelsSkipped: number;
}

/** 纯数据投影不持有身份或业务状态；所有发布仍由Gateway唯一owner执行。 */
export function uncommittedGatewayResult(view: UcasGatewayView): UcasGatewaySyncResult {
  return {
    view: structuredClone(view),
    committed: false,
    apiKeyApplied: false,
    apiKeyReused: false,
    providerHasApiKey: false,
    modelsAdded: 0,
    modelsSkipped: 0,
  };
}

export function committedGatewayResult(
  view: UcasGatewayView,
  applied: AppliedProvisioning,
  apiKeyReused: boolean,
  modelsOnly = false,
): UcasGatewaySyncResult {
  return ucasGatewaySyncResultSchema.parse({
    view: structuredClone(view),
    committed: true,
    apiKeyApplied: !modelsOnly && applied.apiKeyApplied,
    apiKeyReused,
    providerHasApiKey: applied.hasApiKey,
    modelsAdded: applied.modelsAdded,
    modelsSkipped: applied.modelsSkipped,
  });
}

export function readyGatewayProjection(
  current: UcasGatewayView,
  facts: Pick<
    UcasGatewayView,
    "user" | "endpoint" | "key" | "subscriptions" | "usage" | "lastSyncedAt" | "authMode"
  >,
  plan: { ids: readonly string[]; unrestricted: boolean; hasSubscription: boolean },
): Omit<UcasGatewayView, "revision"> {
  return {
    ...current,
    ...facts,
    status: "ready",
    configured: true,
    models: ucasGatewayModelsSchema.parse({
      available: [...plan.ids],
      unrestricted: plan.unrestricted,
      hasSubscription: plan.hasSubscription,
      appliedCount: plan.ids.length,
      pendingCount: 0,
    }),
    error: null,
  };
}

export function emptyGatewayProjection(
  current: UcasGatewayView,
  status: "signed-out" | "idle",
  clearEndpoint = false,
): Omit<UcasGatewayView, "revision"> {
  return {
    ...current,
    status,
    endpoint: clearEndpoint ? null : current.endpoint,
    user: null,
    key: null,
    subscriptions: [],
    usage: null,
    models: null,
    error: null,
  };
}

export function appliedModelsProjection(
  current: UcasGatewayView,
  ids: readonly string[],
): Omit<UcasGatewayView, "revision"> {
  return {
    ...current,
    models: current.models
      ? { ...current.models, available: [...ids], appliedCount: ids.length, pendingCount: 0 }
      : current.models,
  };
}
export function modelCatalogProjection(
  current: UcasGatewayView,
  plan: { models: readonly string[]; unrestricted: boolean; hasSubscription: boolean },
  local: ReadonlySet<string>,
): Omit<UcasGatewayView, "revision"> {
  const pending = plan.models.filter((id) => !local.has(id)).length;
  return {
    ...current,
    models: ucasGatewayModelsSchema.parse({
      available: plan.models,
      unrestricted: plan.unrestricted,
      hasSubscription: plan.hasSubscription,
      appliedCount: plan.models.length - pending,
      pendingCount: pending,
    }),
  };
}

export function initialGatewayView(): UcasGatewayView {
  return {
    revision: 0,
    status: "signed-out",
    configured: false,
    user: null,
    endpoint: null,
    key: null,
    subscriptions: [],
    usage: null,
    models: null,
    lastSyncedAt: null,
    error: null,
  };
}

/** 服务端明确拒绝后旧目录/用量已非授权事实；只撤投影，不伪造身份owner退出。 */
export function failedGatewayProjection(
  current: UcasGatewayView,
  code: UcasGatewayError,
  managed: boolean,
  partial = false,
): Omit<UcasGatewayView, "revision"> {
  return {
    ...(managed && (code === "unauthorized" || code === "forbidden")
      ? emptyGatewayProjection(current, "idle", true)
      : current),
    status: managed || !partial ? "error" : current.status,
    error: code,
  };
}

/** 成功局部刷新只能恢复同owner完整快照；被拒后空投影仍等待完整sync。 */
export function recoveredGatewayProjection(
  current: UcasGatewayView,
  managed: boolean,
): Omit<UcasGatewayView, "revision"> {
  return {
    ...current,
    error: null,
    status:
      managed && current.status === "error"
        ? current.user && current.endpoint && current.models
          ? "ready"
          : "idle"
        : current.status,
  };
}

/** 同次统计查询和当前套餐一起提交，避免只刷新usage而继续展示旧额度。 */
export function refreshedUsageProjection(
  current: UcasGatewayView,
  facts: Pick<UcasGatewayView, "usage"> & Partial<Pick<UcasGatewayView, "subscriptions">>,
): Omit<UcasGatewayView, "revision"> {
  return {
    ...current,
    ...facts,
    status: current.status === "signed-out" ? "ready" : current.status,
  };
}

export function hydratedGatewayProjection(
  current: UcasGatewayView,
  state: import("@zcode/shared").UcasGatewayState,
): Omit<UcasGatewayView, "revision"> {
  return {
    ...current,
    status: "idle",
    endpoint: state.endpoint,
    key: state.key,
    lastSyncedAt: state.lastSyncedAt,
  };
}
