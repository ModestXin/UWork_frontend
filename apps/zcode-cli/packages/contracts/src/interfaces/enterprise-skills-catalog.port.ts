import type { EnterpriseSkillsCatalog } from "@zcode/shared";
import type { TraceContext } from "../tracing/tracer.js";

export interface EnterpriseSkillsCatalogRequest {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  traceContext: TraceContext;
}

/** Current Host projection only. References never replace per-load authorization. */
export interface EnterpriseSkillsCatalogPort {
  readCatalog(
    request: EnterpriseSkillsCatalogRequest,
    signal?: AbortSignal,
  ): Promise<EnterpriseSkillsCatalog>;
}
