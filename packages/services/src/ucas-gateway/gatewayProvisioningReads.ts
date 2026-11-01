import type {
  UcasGatewayEndpoint,
  UcasGatewayView,
  UcasGatewayError,
  UcasGatewayUsageRequest,
} from "@zcode/shared";
import type { GatewayIdentityScope } from "./gatewayIdentityScope.js";
import type { UcasGatewayProvisioningTarget } from "./contract.js";
import { UcasGatewayRequestError } from "./ucasGatewayClient.js";
import type { UWorkGatewayModelDescriptor } from "./contract.js";
import type { UcasGatewayClient } from "./ucasGatewayClient.js";
/** 无可变状态的协议读取辅助；副作用准入与视图提交始终由Gateway owner负责。 */
const GATEWAY_KEY_ALIAS = "UWork";

/**
 * 只使用公网 HTTPS 入口。服务端同时下发 `llm_base_url_internal`（明文 http、仅校园网可达），
 * 需要统一走 TLS 且不把内网地址带进客户端，因此既不探测也不写入 Provider 配置。
 */
export const resolveGatewayEndpoint = (endpoints: {
  publicBaseUrl: string;
}): UcasGatewayEndpoint => ({
  baseUrl: endpoints.publicBaseUrl,
  publicBaseUrl: endpoints.publicBaseUrl,
  internalBaseUrl: null,
  source: "public",
});
export const ensureGatewayKey = async (
  client: UcasGatewayClient,
  managed = false,
): Promise<{
  key: UcasGatewayView["key"];
  apiKey: string | undefined;
  reused: boolean;
}> => {
  if (managed) return { key: null, apiKey: undefined, reused: false };
  if (client.issueDeviceCredential)
    return { ...(await client.issueDeviceCredential()), reused: false };
  const keys = await client.listKeys();
  const active = keys.find((item) => item.status === "active") ?? keys[0];
  if (active) {
    const apiKey = await client.revealKey(active.id);
    return { key: active, apiKey, reused: true };
  }
  const generated = await client.generateKey(GATEWAY_KEY_ALIAS);
  return { key: generated.key, apiKey: generated.apiKey, reused: false };
};
export const readGatewayPlanModels = async (
  client: UcasGatewayClient,
  endpoint: UcasGatewayEndpoint,
  apiKey: string | undefined,
): Promise<{
  ids: readonly string[];
  descriptors?: readonly UWorkGatewayModelDescriptor[];
  unrestricted: boolean;
  hasSubscription: boolean;
}> => {
  const plan = await client.readPlanModels();
  if (plan.models.length > 0 || plan.descriptors !== undefined) {
    return {
      ids: plan.models,
      ...(plan.descriptors ? { descriptors: plan.descriptors } : {}),
      unrestricted: plan.unrestricted,
      hasSubscription: plan.hasSubscription,
    };
  }
  // 套餐不限模型时回退到协议级 `/models`；读取失败不阻断 Key 与端点配置。
  try {
    if (apiKey === undefined)
      return { ids: [], unrestricted: plan.unrestricted, hasSubscription: plan.hasSubscription };
    const ids = await client.listEndpointModels(endpoint.baseUrl, apiKey);
    return {
      ids,
      unrestricted: plan.unrestricted,
      hasSubscription: plan.hasSubscription,
    };
  } catch {
    return {
      ids: [],
      unrestricted: plan.unrestricted,
      hasSubscription: plan.hasSubscription,
    };
  }
};

export async function readGatewayModelApplication(
  client: UcasGatewayClient | undefined,
  ids: readonly string[],
): Promise<{ ids: readonly string[]; descriptors?: readonly UWorkGatewayModelDescriptor[] }> {
  if (!client) return { ids };
  const plan = await client.readPlanModels();
  return { ids: plan.models, ...(plan.descriptors ? { descriptors: plan.descriptors } : {}) };
}

/** 账户读操作不持有状态；最终发布与身份复核仍由原Gateway owner完成。 */
export async function readGatewayAccountStats(
  client: UcasGatewayClient,
  usage: UcasGatewayView["usage"] | UcasGatewayUsageRequest,
  managed = false,
) {
  // 旧UCAS允许统计缺席；自有后端失败不能吞掉，否则已撤销会话仍会被发布为ready。
  const subscriptions = [
    ...(await client.readSubscriptions().catch((error) => {
      if (managed) throw error;
      return [];
    })),
  ];
  if (
    managed &&
    subscriptions.some(
      (plan) =>
        plan.status !== "active" || plan.effectiveAllowance?.reason === "subscription_inactive",
    )
  )
    throw new UcasGatewayRequestError("forbidden", 402);
  const currentUsage = await client
    .readUsage({
      period: usage?.period ?? "month",
      metric: usage?.metric ?? "requests",
      ...(usage && "force" in usage ? { force: usage.force } : {}),
    })
    .catch((error) => {
      if (managed) throw error;
      return null;
    });
  return { subscriptions, usage: currentUsage };
}

/** 撤销的是候选投影；实际写入仍由原Provider单写者及原身份lease裁决。 */
export async function clearRejectedGatewayCatalog(
  target: UcasGatewayProvisioningTarget,
  scope: GatewayIdentityScope | undefined,
  apiBaseUrl: string,
  error: unknown,
) {
  if (
    !scope?.managed ||
    !scope.isCurrent() ||
    !(error instanceof UcasGatewayRequestError) ||
    (error.kind !== "unauthorized" && error.kind !== "forbidden")
  )
    return;
  await stageEmptyGatewayCatalog(target, scope, apiBaseUrl);
}

/** 只分类不记录原始错误，避免网络/解析异常携带私有正文进入诊断。 */
export function classifyGatewayFailure(error: unknown): { code: UcasGatewayError; reason: string } {
  if (error instanceof UcasGatewayRequestError) {
    if (error.kind === "forbidden" || error.kind === "unauthorized" || error.kind === "network")
      return { code: error.kind, reason: error.kind };
    return { code: "failed", reason: `http-${error.status ?? 0}` };
  }
  return { code: "failed", reason: "unexpected" };
}

/** 成功目录刷新仍走同一私有写入路径；空目录必须实际清候选，不能只改UI计数。 */
export async function applyCurrentGatewayCatalog(
  target: UcasGatewayProvisioningTarget,
  scope: GatewayIdentityScope,
  endpoint: UcasGatewayEndpoint,
  plan: { models: readonly string[]; descriptors?: readonly UWorkGatewayModelDescriptor[] },
) {
  await scope.assertCurrent();
  await target.apply({
    baseUrl: endpoint.baseUrl,
    authMode: "enterprise-session",
    modelIds: plan.models,
    ...(plan.descriptors ? { managedModels: plan.descriptors } : {}),
    isCurrent: scope.isCurrent,
  });
  await scope.assertCurrent();
}

export function isGatewayAuthorizationRejection(error: unknown): boolean {
  return (
    error instanceof UcasGatewayRequestError &&
    (error.kind === "unauthorized" || error.kind === "forbidden")
  );
}

/** 新owner/未绑定投影也使用同一私有清候选命令，不复制另一条文件写路径。 */
export async function stageEmptyGatewayCatalog(
  target: UcasGatewayProvisioningTarget,
  scope: GatewayIdentityScope,
  apiBaseUrl: string,
) {
  await scope.assertCurrent();
  await target.apply({
    baseUrl: new URL("/v1", apiBaseUrl).href,
    authMode: "enterprise-session",
    modelIds: [],
    managedModels: [],
    isCurrent: scope.isCurrent,
  });
  await scope.assertCurrent();
}
