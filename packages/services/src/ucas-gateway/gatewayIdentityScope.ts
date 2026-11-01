import type { EnterpriseIdentitySession } from "@zcode/shared";
import type { EnterpriseIdentityAuthority } from "../enterprise-identity/identityServiceLifecycle.js";
import {
  UcasGatewayRequestError,
  createUcasGatewayClient,
  type UcasGatewayClientOptions,
} from "./ucasGatewayClient.js";
import { createUWorkGatewayClient } from "./uworkGatewayClient.js";

export interface GatewayIdentitySource {
  readIdentitySession(): Promise<EnterpriseIdentitySession | null>;
  /** Host私有端口，只读现有身份owner，不作为Renderer/RPC入口。 */
  readIdentityAuthority?: () => EnterpriseIdentityAuthority | undefined;
  subscribeIdentityChanges?: (listener: () => void) => { dispose(): void };
  resolveApiBaseUrl(): Promise<string | undefined>;
  resolveBackend?: () => Promise<"ucas" | "uwork">;
}

export interface GatewayIdentityScope {
  readonly signal?: AbortSignal;
  readonly issuerOrigin?: string;
  readonly managed: boolean;
  isCurrent(): boolean;
  assertCurrent(): Promise<void>;
}

/** 单次操作只绑定已有owner；缓存目录和持久化Token本身不能代替即时撤销代际。 */
export function createGatewayIdentityScope(
  source: GatewayIdentitySource,
  session: EnterpriseIdentitySession,
  apiBaseUrl: string,
  backend: "ucas" | "uwork",
  isDisposed: () => boolean,
): GatewayIdentityScope {
  if (backend !== "uwork") {
    // UCAS历史适配没有本项目的私有authority；保持原协议行为，不伪造managed授权。
    return {
      managed: false,
      isCurrent: () => !isDisposed(),
      async assertCurrent() {
        if (isDisposed()) throw new UcasGatewayRequestError("unauthorized");
      },
    };
  }
  const origin = new URL(apiBaseUrl).origin;
  const initial = source.readIdentityAuthority?.();
  const sameSession = (value: EnterpriseIdentitySession | null | undefined) =>
    value?.token === session.token &&
    value.issuerOrigin === origin &&
    value.profile.id === session.profile.id &&
    value.profile.tenantId === session.profile.tenantId &&
    value.expiresAt > Date.now();
  if (!initial || initial.signal.aborted || !sameSession(initial.session))
    throw new UcasGatewayRequestError("unauthorized");
  let invalidated = false;
  const isCurrent = () => {
    const current = source.readIdentityAuthority?.();
    return (
      !invalidated &&
      !isDisposed() &&
      !initial.signal.aborted &&
      !!current &&
      !current.signal.aborted &&
      current.generation === initial.generation &&
      current.revision === initial.revision &&
      sameSession(current.session)
    );
  };
  const assertOwner = () => {
    if (!isCurrent()) throw new UcasGatewayRequestError("unauthorized");
  };
  return {
    managed: true,
    issuerOrigin: origin,
    signal: initial.signal,
    isCurrent,
    async assertCurrent() {
      try {
        assertOwner();
        const persisted = await source.readIdentitySession();
        assertOwner();
        if (!sameSession(persisted)) throw new UcasGatewayRequestError("unauthorized");
        const currentBackend = await source.resolveBackend?.();
        assertOwner();
        const currentBaseUrl = await source.resolveApiBaseUrl();
        assertOwner();
        if (
          currentBackend !== "uwork" ||
          !currentBaseUrl ||
          new URL(currentBaseUrl).origin !== origin
        )
          throw new UcasGatewayRequestError("unauthorized");
      } catch (error) {
        // 配置/持久化绑定失效也必须废弃该操作，不能只靠同步generation保留旧投影。
        invalidated = true;
        throw error;
      }
    },
  };
}

export function createScopedGatewayClient(
  source: GatewayIdentitySource & Pick<UcasGatewayClientOptions, "fetchImpl" | "timeoutMs">,
  session: EnterpriseIdentitySession,
  apiBaseUrl: string,
  backend: "ucas" | "uwork",
  scope: GatewayIdentityScope,
) {
  return (backend === "uwork" ? createUWorkGatewayClient : createUcasGatewayClient)({
    apiBaseUrl,
    token: session.token,
    issuerOrigin: session.issuerOrigin,
    ...(scope.signal ? { signal: scope.signal } : {}),
    ...(source.fetchImpl ? { fetchImpl: source.fetchImpl } : {}),
    ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
  });
}

/** 只验证投影归属，不授予新的操作权限；失败后由原Gateway owner重新同步。 */
export async function isGatewayProjectionCurrent(
  scope: GatewayIdentityScope | null,
  endpoint: string | undefined,
  apiBaseUrl: string | undefined,
): Promise<boolean> {
  if (!scope?.managed || !endpoint || !apiBaseUrl) return false;
  try {
    await scope.assertCurrent();
    return new URL(endpoint).origin === new URL(apiBaseUrl).origin;
  } catch {
    return false;
  }
}

/** 只绑定同一Gateway的只读identity端口与dispose检查，不创建身份状态。 */
export function createGatewayIdentityScopeFactory(
  source: GatewayIdentitySource,
  isDisposed: () => boolean,
) {
  return (session: EnterpriseIdentitySession, apiBaseUrl: string, backend: "ucas" | "uwork") =>
    createGatewayIdentityScope(source, session, apiBaseUrl, backend, isDisposed);
}
