import {
  zcodeEnterpriseToolAuthorizationParamsSchema,
  zcodeEnterpriseToolAuthorizationResultSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { EnterpriseToolAuthorizationPort } from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

export type EnterpriseToolAuthorizationContext = Pick<
  ZCodeProtocolAgentServerContext,
  "requestClient" | "notify"
>;
const AUTHORIZATION_TIMEOUT_MS = 15000;
let sequence = 0;

export function createProtocolEnterpriseToolAuthorization(input: {
  context: () => EnterpriseToolAuthorizationContext | undefined;
  workspace: (request: { workspacePath: string; workspaceIdentity?: string }) => ZCodeWorkspaceRef;
}): EnterpriseToolAuthorizationPort {
  return {
    async authorize(request, signal) {
      const context = input.context();
      if (!context) return { allowed: false, code: "enterprise_policy_unavailable" };
      const parsed = zcodeEnterpriseToolAuthorizationParamsSchema.safeParse({
        requestId: `enterprise-tool:${++sequence}`,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        workspace: input.workspace(request),
        workingDirectory: request.workingDirectory,
        input: request.input,
        capability: request.capability,
        phase: request.phase,
        ...(request.asset ? { asset: request.asset } : {}),
        ...(request.ownerKey ? { ownerKey: request.ownerKey } : {}),
      });
      if (!parsed.success) return { allowed: false, code: "enterprise_input_limit" };
      try {
        signal?.throwIfAborted();
        const result = await context.requestClient(
          zcodeProtocolMethods.interactionAuthorizeEnterpriseTool,
          parsed.data,
          zcodeEnterpriseToolAuthorizationResultSchema,
          {
            signal,
            timeoutMs: AUTHORIZATION_TIMEOUT_MS,
            trace: {
              traceId: request.traceContext.traceId,
              spanId: request.traceContext.spanId,
              ...(request.traceContext.parentSpanId
                ? { parentId: request.traceContext.parentSpanId }
                : {}),
            },
          },
        );
        signal?.throwIfAborted();
        return result;
      } catch {
        try {
          context.notify({
            method: zcodeProtocolNotifications.enterpriseToolAuthorizationCancelled,
            params: {
              requestId: parsed.data.requestId,
              sessionId: parsed.data.sessionId,
              workspace: parsed.data.workspace,
            },
            trace: {
              traceId: request.traceContext.traceId,
              spanId: request.traceContext.spanId,
              ...(request.traceContext.parentSpanId
                ? { parentId: request.traceContext.parentSpanId }
                : {}),
            },
          });
        } catch {
          /* 已关闭连接不再产生副作用。 */
        }
        return {
          allowed: false,
          code: signal?.aborted
            ? "enterprise_authorization_cancelled"
            : "enterprise_policy_unavailable",
        };
      }
    },
  };
}
