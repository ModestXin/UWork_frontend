import {
  zcodeEnterpriseConnectorParamsSchema,
  zcodeEnterpriseConnectorResultSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodeEnterpriseConnectorResult,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type {
  EnterpriseConnectorPort,
  EnterpriseConnectorReleaseRequest,
  EnterpriseConnectorRequest,
} from "@zcode/contracts";
import type { EnterpriseToolAuthorizationContext } from "./enterprise-tool-authorization.js";

// CLI 时限必须晚于 Host 的 45 秒，让 Host 先形成确定结果。
const CONNECTOR_TIMEOUT_MS = 50000;
let sequence = 0;

export function createProtocolEnterpriseConnectorPort(input: {
  context: () => EnterpriseToolAuthorizationContext | undefined;
  workspace: (request: { workspacePath: string; workspaceIdentity?: string }) => ZCodeWorkspaceRef;
}): EnterpriseConnectorPort {
  const denied = (code: string): ZCodeEnterpriseConnectorResult => ({ status: "denied", code });
  const perform = async (
    request: EnterpriseConnectorRequest | EnterpriseConnectorReleaseRequest,
    frame: unknown | undefined,
    signal?: AbortSignal,
  ): Promise<ZCodeEnterpriseConnectorResult> => {
    const context = input.context();
    if (!context) return denied("enterprise_policy_unavailable");
    const parsed = zcodeEnterpriseConnectorParamsSchema.safeParse({
      requestId: `enterprise-connector:${++sequence}`,
      sessionId: request.sessionId,
      workspace: input.workspace({
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      }),
      connector: request.connector,
      ownerKey: request.ownerKey,
      request:
        frame === undefined
          ? { kind: "release", mcpSessionId: request.mcpSessionId }
          : {
              kind: "rpc",
              frame,
              ...(request.mcpSessionId ? { mcpSessionId: request.mcpSessionId } : {}),
            },
    });
    if (!parsed.success) return denied("enterprise_input_limit");
    const trace = {
      traceId: request.traceContext.traceId,
      spanId: request.traceContext.spanId,
      ...(request.traceContext.parentSpanId ? { parentId: request.traceContext.parentSpanId } : {}),
    };
    try {
      signal?.throwIfAborted();
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionRequestEnterpriseConnector,
        parsed.data,
        zcodeEnterpriseConnectorResultSchema,
        { signal, timeoutMs: CONNECTOR_TIMEOUT_MS, trace },
      );
      signal?.throwIfAborted();
      return zcodeEnterpriseConnectorResultSchema.parse(result);
    } catch {
      try {
        context.notify({
          method: zcodeProtocolNotifications.enterpriseToolAuthorizationCancelled,
          params: {
            requestId: parsed.data.requestId,
            sessionId: parsed.data.sessionId,
            workspace: parsed.data.workspace,
          },
          trace,
        });
      } catch {
        /* 已关闭连接不再产生副作用。 */
      }
      return denied(
        signal?.aborted ? "enterprise_authorization_cancelled" : "enterprise_policy_unavailable",
      );
    }
  };
  return {
    request: (request, signal) => perform(request, request.frame, signal),
    release: (request, signal) => perform(request, undefined, signal),
  };
}
