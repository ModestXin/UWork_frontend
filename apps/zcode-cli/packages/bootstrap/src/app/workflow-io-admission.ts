import { isCoreError, type WorkflowExecutionAdmission } from "@zcode/contracts";

export interface WorkflowIoAdmission {
  admission?: WorkflowExecutionAdmission;
  executionSignal?: AbortSignal;
}

export async function withWorkflowIo<T>(
  scope: WorkflowIoAdmission,
  operation: () => Promise<T>,
): Promise<T> {
  scope.executionSignal?.throwIfAborted();
  await scope.admission?.revalidate(scope.executionSignal);
  scope.executionSignal?.throwIfAborted();
  const value = await operation();
  await scope.admission?.revalidate(scope.executionSignal);
  scope.executionSignal?.throwIfAborted();
  return value;
}

export function isWorkflowAuthorizationError(error: unknown): boolean {
  return isCoreError(error) && error.context?.source === "enterprise-policy";
}
