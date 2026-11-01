import type { TraceContext, WorkflowExecutionAdmission } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { createWorkflowExecutionAdmission } from "../helpers/workflow-execution-authorization.js";

/** Runtime 提供当前执行范围；Bootstrap 不复制 cwd 或 session 权威。 */
export function createWorkflowAdmission(
  this: AgentRuntimeInternal,
  input: { traceContext?: TraceContext; signal?: AbortSignal } = {},
): Promise<WorkflowExecutionAdmission> {
  const cwd = this.workingDirectory,
    root = this.workspaceRoot;
  const identity = this.config.memory?.workspaceIdentity;
  return createWorkflowExecutionAdmission({
    authorization: this.permissionService.enterpriseAuthorization,
    sessionId: this.sessionId,
    workspacePath: root,
    workspaceIdentity: identity,
    workingDirectory: cwd,
    traceContext: input.traceContext ?? this.rootTraceContext,
    signal: input.signal,
    isCurrent: () =>
      !this.shuttingDown &&
      this.workingDirectory === cwd &&
      this.workspaceRoot === root &&
      this.config.memory?.workspaceIdentity === identity,
  });
}
