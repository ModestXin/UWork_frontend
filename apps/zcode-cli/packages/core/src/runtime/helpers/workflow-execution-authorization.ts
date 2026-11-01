import {
  CoreErrorType,
  createCoreError,
  type EnterpriseToolAuthorizationPort,
  type TraceContext,
  type WorkflowExecutionAdmission,
} from "@zcode/contracts";

export interface WorkflowAuthorizationContext {
  authorization?: EnterpriseToolAuthorizationPort;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workingDirectory: string;
  traceContext: TraceContext;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

/** 同次操作绑定身份，不保存允许决定；每次 IO/提交仍询问当前 Host。 */
export async function createWorkflowExecutionAdmission(
  context: WorkflowAuthorizationContext,
): Promise<WorkflowExecutionAdmission> {
  let owner: string | undefined;
  let managed: boolean | undefined;
  const revalidate = async (signal?: AbortSignal): Promise<void> => {
    const signals = [context.signal, signal].filter((value): value is AbortSignal => !!value);
    const cancellation = signals.length ? AbortSignal.any(signals) : undefined;
    let code = "enterprise_policy_unavailable";
    try {
      cancellation?.throwIfAborted();
      if (context.isCurrent?.() === false) {
        code = "enterprise_execution_context_changed";
        throw new Error("closed");
      }
      if (!context.authorization) return;
      const decision = await cancellable(
        context.authorization.authorize(
          {
            toolName: "WorkflowExecutionAdmission",
            toolCallId: crypto.randomUUID(),
            sessionId: context.sessionId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
            workingDirectory: context.workingDirectory,
            input: {},
            phase: "before_dispatch",
            capability: {
              permission: "filesystem",
              sideEffectScope: "workspace",
              readOnly: false,
              destructive: false,
            },
            traceContext: context.traceContext,
          },
          cancellation,
        ),
        cancellation,
      );
      cancellation?.throwIfAborted();
      if (context.isCurrent?.() === false) code = "enterprise_execution_context_changed";
      else if (!decision.allowed)
        code = /^enterprise_[a-z_]{1,64}$/.test(decision.code) ? decision.code : code;
      else {
        const currentManaged = decision.code !== "not_managed";
        if (currentManaged && !/^[a-f0-9]{64}$/.test(decision.ownerKey ?? ""))
          code = "enterprise_policy_unavailable";
        else if (
          managed !== undefined &&
          (managed !== currentManaged || owner !== decision.ownerKey)
        )
          code = "enterprise_identity_changed";
        else {
          managed = currentManaged;
          owner = decision.ownerKey;
          return;
        }
      }
    } catch {
      // 授权失败只暴露稳定码，迟到 allowed 和底层私有错误不能继续操作。
    }
    if (cancellation?.aborted) code = "enterprise_authorization_cancelled";
    throw createCoreError(CoreErrorType.PermissionDenied, code, {
      context: { code, source: "enterprise-policy" },
      recoverable: true,
    });
  };
  await revalidate();
  return Object.freeze({ revalidate });
}

function cancellable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
