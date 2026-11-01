import {
  createHttpClientError,
  type EnterpriseToolAuthorizationPort,
  type HttpClientPort,
  type TraceContext,
} from "@zcode/contracts";

export function withEnterpriseHttpAuthorization(
  port: HttpClientPort,
  context: {
    authorization?: EnterpriseToolAuthorizationPort;
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    workingDirectory: string;
    traceContext: TraceContext;
  },
): HttpClientPort {
  const authorization = context.authorization;
  if (!authorization) return port;
  return {
    enterpriseNetworkGuarded: true,
    async request(request, options) {
      const signals = [options?.signal, options?.context?.abortSignal].filter(
        (value): value is AbortSignal => !!value,
      );
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      const prepared = {
        ...request,
        headers: request.headers ? { ...request.headers } : undefined,
        body: request.body?.slice(),
      };
      let code = "enterprise_policy_unavailable";
      let managedAllowed = false;
      try {
        signal?.throwIfAborted();
        const decision = await authorization.authorize(
          {
            toolName: "EnterpriseNetworkIO",
            toolCallId: crypto.randomUUID(),
            sessionId: context.sessionId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
            workingDirectory: context.workingDirectory,
            phase: "network_request",
            input: { url: prepared.url },
            capability: {
              permission: "network",
              sideEffectScope: "network",
              readOnly: true,
              destructive: false,
              networkGuarded: true,
            },
            traceContext: request.trace ?? options?.context?.trace ?? context.traceContext,
          },
          signal,
        );
        signal?.throwIfAborted();
        if (decision?.allowed === true && decision.code === "not_managed")
          return port.request(prepared, { ...options, signal });
        managedAllowed = decision?.allowed === true && decision.code === "allowed";
        if (typeof decision?.code === "string" && /^[a-z_]{1,80}$/.test(decision.code))
          code = decision.code;
      } catch {
        /* 授权错误不带出 URL、请求头或响应中的私密数据。 */
      }
      if (managedAllowed) {
        // 自动跳转无法逐跳裁决，受管请求必须交由调用方显式处理下一跳。
        if (prepared.redirect === "follow")
          throw createHttpClientError({
            code: "egress_blocked",
            message: "enterprise_redirect_unsupported",
          });
        return port.request(
          { ...prepared, redirect: "manual", egressPolicy: "public" },
          { ...options, signal },
        );
      }
      throw createHttpClientError({
        code: signal?.aborted ? "cancelled" : "egress_blocked",
        message: signal?.aborted ? "enterprise_authorization_cancelled" : code,
      });
    },
  };
}
