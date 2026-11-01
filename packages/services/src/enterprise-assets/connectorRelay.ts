import type { EnterpriseConnectorReference } from "@zcode/shared";
import type {
  UWorkBackendScope,
  UWorkBackendSession,
} from "../enterprise-identity/backendSessionContract.js";
import { UWorkBackendSessionError } from "../enterprise-identity/backendSessionContract.js";
import { EnterpriseAssetStoreError } from "./assetPackage.js";
import { downloadHostConnector } from "./hostBackendAssets.js";
import type { EnterpriseAssetsHost } from "./hostContract.js";

/** 后端网关的错误码 → 稳定、可枚举的 CLI 失败分类；不回传服务端文本。 */
const deniedCodes: Record<string, string> = {
  ASSET_DENIED: "enterprise_connector_denied",
  ASSET_VERSION_CHANGED: "enterprise_asset_changed",
  CONNECTOR_DENIED: "enterprise_connector_denied",
  CONNECTOR_VERSION_CHANGED: "enterprise_asset_changed",
  CREDENTIAL_CHANGED: "enterprise_asset_changed",
  FORBIDDEN: "enterprise_connector_denied",
  IP_DENIED: "enterprise_connector_denied",
  MEMBER_INACTIVE: "enterprise_connector_denied",
  NO_MEMBERSHIP: "enterprise_connector_denied",
  SESSION_EXPIRED: "enterprise_connector_denied",
  SUBSCRIPTION_INACTIVE: "enterprise_subscription_inactive",
  TOOL_DENIED: "enterprise_connector_tool_denied",
};
function statusCode(status: number): string {
  if (status === 402) return "enterprise_subscription_inactive";
  if (status === 429) return "enterprise_connector_limited";
  if (status === 401 || status === 403) return "enterprise_connector_denied";
  if (status === 409) return "enterprise_asset_changed";
  return "enterprise_connector_unavailable";
}
function backendCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
function safeCode(error: unknown): string {
  return (error instanceof EnterpriseAssetStoreError ||
    error instanceof UWorkBackendSessionError) &&
    /^enterprise_[a-z_]{1,64}$/.test(error.code)
    ? error.code
    : "enterprise_connector_unavailable";
}

export type EnterpriseConnectorRelayResult =
  | { status: "ok"; frame?: unknown; mcpSessionId?: string }
  | { status: "denied"; code: string };

export interface EnterpriseConnectorRelayRequest {
  ownerKey: string;
  connector: EnterpriseConnectorReference;
  frame: unknown;
  mcpSessionId?: string;
  signal?: AbortSignal;
  traceId: string;
}

/**
 * 连接器的唯一出口：CLI 只提交 MCP 帧，Host 用私有后端会话把它转给
 * `POST /api/client/connectors/:id/rpc`，远端地址、凭据与远端会话都不出 Host。
 */
export interface EnterpriseConnectorRelay {
  request(input: EnterpriseConnectorRelayRequest): Promise<EnterpriseConnectorRelayResult>;
  release(input: {
    ownerKey: string;
    connector: EnterpriseConnectorReference;
    mcpSessionId: string;
    signal?: AbortSignal;
    traceId: string;
  }): Promise<EnterpriseConnectorRelayResult>;
}

export function createEnterpriseConnectorRelay(options: {
  backendSession: UWorkBackendSession;
  assets: Pick<EnterpriseAssetsHost, "authorizeAsset">;
}): EnterpriseConnectorRelay {
  // 掩码描述只在真正加载时读取一次，并绑定该不可变版本；路径来自服务端，
  // 不由客户端拼接。里面没有远端地址、凭据或后端会话。
  const gatewayPaths = new Map<string, string>();
  const admit = async (
    input: {
      ownerKey: string;
      connector: EnterpriseConnectorReference;
      signal?: AbortSignal;
      traceId: string;
    },
    scope: UWorkBackendScope,
  ): Promise<{ status: "denied"; code: string } | undefined> => {
    const decision = await options.assets.authorizeAsset(
      { asset: input.connector.asset },
      input.traceId,
      scope.signal,
      input.ownerKey,
    );
    return decision.allowed ? undefined : { status: "denied", code: decision.code };
  };
  const gatewayPath = async (
    input: { connector: EnterpriseConnectorReference; signal?: AbortSignal; traceId: string },
    scope: UWorkBackendScope,
  ): Promise<string> => {
    const binding = `${input.connector.asset.id}@${input.connector.asset.version}`;
    const cached = gatewayPaths.get(binding);
    if (cached) return cached;
    const descriptor = await downloadHostConnector(scope, input.connector.asset);
    if (descriptor.transport !== "streamable-http")
      throw new EnterpriseAssetStoreError("enterprise_connector_unavailable");
    gatewayPaths.set(binding, descriptor.gatewayUrl);
    return descriptor.gatewayUrl;
  };
  return {
    async request(input) {
      try {
        if (input.signal?.aborted)
          return { status: "denied", code: "enterprise_authorization_cancelled" };
        const result = await options.backendSession.run(
          async (scope) => {
            // 逐次准入与转发之间不做缓存：目录/身份变化后旧允许结果不能继续放行。
            const denied = await admit(input, scope);
            if (denied) return denied;
            const path = await gatewayPath(input, scope);
            const response = await scope.request(
              path,
              input.frame,
              input.mcpSessionId ? { mcpSessionId: input.mcpSessionId } : {},
            );
            if (response.status < 200 || response.status >= 300)
              return {
                status: "denied" as const,
                code:
                  (backendCode(response.body)
                    ? deniedCodes[backendCode(response.body)!]
                    : undefined) ?? statusCode(response.status),
              };
            // 202/204 表示通知已被接收；有正文时必须是后端已校验 ID 的帧。
            return {
              status: "ok" as const,
              ...(response.body === undefined ? {} : { frame: response.body }),
              ...(response.mcpSessionId ? { mcpSessionId: response.mcpSessionId } : {}),
            };
          },
          { signal: input.signal, traceId: input.traceId },
        );
        return result.managed
          ? result.value
          : { status: "denied", code: "enterprise_policy_unavailable" };
      } catch (error) {
        return { status: "denied", code: safeCode(error) };
      }
    },
    async release(input) {
      try {
        if (input.signal?.aborted)
          return { status: "denied", code: "enterprise_authorization_cancelled" };
        const result = await options.backendSession.run(
          async (scope) => {
            const denied = await admit(input, scope);
            if (denied) return { status: "ok" as const };
            const path = await gatewayPath(input, scope);
            const response = await scope.request(path, undefined, {
              method: "DELETE",
              mcpSessionId: input.mcpSessionId,
            });
            if (response.status < 200 || response.status >= 300)
              return {
                status: "denied" as const,
                code:
                  (backendCode(response.body)
                    ? deniedCodes[backendCode(response.body)!]
                    : undefined) ?? statusCode(response.status),
              };
            return { status: "ok" as const };
          },
          { signal: input.signal, traceId: input.traceId },
        );
        return result.managed
          ? result.value
          : { status: "denied", code: "enterprise_policy_unavailable" };
      } catch (error) {
        return { status: "denied", code: safeCode(error) };
      }
    },
  };
}
