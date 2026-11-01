import {
  zcodeEnterpriseModelRequestParamsSchema,
  zcodeEnterpriseModelRequestResultSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { EnterpriseModelRelayPort } from "@zcode/contracts";
import type { EnterpriseToolAuthorizationContext } from "./enterprise-tool-authorization.js";

const MODEL_RPC_TIMEOUT_MS = 130000;
let sequence = 0;

/** 复用现有runtime/workspace反向RPC和取消通知；不持有身份或远端stream集合。 */
export function createProtocolEnterpriseModelRelay(input: {
  context: () => EnterpriseToolAuthorizationContext | undefined;
  workspace: (request: { workspacePath: string; workspaceIdentity?: string }) => ZCodeWorkspaceRef;
}): EnterpriseModelRelayPort {
  return {
    async request(request, signal) {
      const context = input.context();
      if (!context) return { status: "denied", code: "enterprise_policy_unavailable" };
      const params = zcodeEnterpriseModelRequestParamsSchema.parse({
        requestId: `enterprise-model:${++sequence}`,
        sessionId: request.sessionId,
        workspace: input.workspace(request),
        request: request.request,
      });
      const trace = {
        traceId: request.traceContext.traceId,
        spanId: request.traceContext.spanId,
        ...(request.traceContext.parentSpanId
          ? { parentId: request.traceContext.parentSpanId }
          : {}),
      };
      try {
        signal?.throwIfAborted();
        const result = await context.requestClient(
          zcodeProtocolMethods.interactionEnterpriseModelRequest,
          params,
          zcodeEnterpriseModelRequestResultSchema,
          { signal, timeoutMs: MODEL_RPC_TIMEOUT_MS, trace },
        );
        signal?.throwIfAborted();
        return zcodeEnterpriseModelRequestResultSchema.parse(result);
      } catch (error) {
        try {
          context.notify({
            method: zcodeProtocolNotifications.enterpriseToolAuthorizationCancelled,
            params: {
              requestId: params.requestId,
              sessionId: params.sessionId,
              workspace: params.workspace,
            },
            trace,
          });
        } catch {
          /* 连接已关闭时Host runtime owner负责回收。 */
        }
        if (signal?.aborted) throw signal.reason;
        throw error;
      }
    },
  };
}
