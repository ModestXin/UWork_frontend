import {
  enterpriseSkillsCatalogSchema,
  zcodeEnterpriseSkillsCatalogParamsSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { EnterpriseSkillsCatalogPort } from "@zcode/contracts";
import type { EnterpriseToolAuthorizationContext } from "./enterprise-tool-authorization.js";

const CATALOG_TIMEOUT_MS = 65000;
let sequence = 0;

export function createProtocolEnterpriseSkillsCatalog(input: {
  context: () => EnterpriseToolAuthorizationContext | undefined;
  workspace: (request: { workspacePath: string; workspaceIdentity?: string }) => ZCodeWorkspaceRef;
}): EnterpriseSkillsCatalogPort {
  return {
    async readCatalog(request, signal) {
      const context = input.context();
      if (!context) return { status: "denied", code: "enterprise_policy_unavailable" };
      const parsed = zcodeEnterpriseSkillsCatalogParamsSchema.safeParse({
        requestId: `enterprise-assets:${++sequence}`,
        sessionId: request.sessionId,
        workspace: input.workspace(request),
      });
      if (!parsed.success) return { status: "denied", code: "enterprise_input_limit" };
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
          zcodeProtocolMethods.interactionReadEnterpriseSkills,
          parsed.data,
          enterpriseSkillsCatalogSchema,
          { signal, timeoutMs: CATALOG_TIMEOUT_MS, trace },
        );
        signal?.throwIfAborted();
        return enterpriseSkillsCatalogSchema.parse(result);
      } catch {
        try {
          // Catalog 与工具准入共享 Host pending owner，取消也走同一条连接/会话通道。
          context.notify({
            method: zcodeProtocolNotifications.enterpriseToolAuthorizationCancelled,
            params: parsed.data,
            trace,
          });
        } catch {
          /* 已关闭连接不再产生副作用。 */
        }
        return {
          status: "denied",
          code: signal?.aborted
            ? "enterprise_authorization_cancelled"
            : "enterprise_policy_unavailable",
        };
      }
    },
  };
}
