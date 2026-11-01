import { createSessionId, type WorkflowExecutionAdmission } from "@zcode/contracts";
import { createWorkflowExecutionAdmission } from "@zcode/core";
import type { ZCodeProtocolTrace, ZCodeWorkspaceRef } from "@zcode/shared";
import {
  createProtocolRootTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

export function acquireWorkflowWorkspaceAdmission(
  context: ZCodeProtocolAgentServerContext,
  requested: ZCodeWorkspaceRef,
  trace?: ZCodeProtocolTrace,
): Promise<WorkflowExecutionAdmission> {
  const bound = context.deps.enterpriseWorkspace;
  const managed = Boolean(
    context.deps.enterpriseToolAuthorization || context.deps.enterpriseSkillsCatalog,
  );
  const matches = () =>
    !managed ||
    Boolean(
      bound &&
      requested.workspacePath === bound.workspacePath &&
      requested.workspaceKey === bound.workspaceKey &&
      (requested.workspaceIdentity?.trim() ?? "") === (bound.workspaceIdentity?.trim() ?? "") &&
      context.deps.enterpriseWorkspace === bound,
    );
  if (!matches()) throw new Error("enterprise_workspace_mismatch");
  if (managed && !context.deps.enterpriseToolAuthorization)
    throw new Error("enterprise_policy_unavailable");
  const workspace = bound ?? requested;
  return createWorkflowExecutionAdmission({
    authorization: context.deps.enterpriseToolAuthorization,
    sessionId: "enterprise-workflows",
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
    workingDirectory: workspace.workspacePath,
    traceContext: createProtocolRootTraceContext(createSessionId("enterprise-workflows"), trace),
    isCurrent: matches,
  });
}
