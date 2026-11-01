import {
  createCoreError,
  CoreErrorType,
  type EnterpriseToolAuthorizationPort,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionRunOptions,
  type TraceContext,
} from "@zcode/contracts";

export function withEnterpriseExecutionAuthorization(
  port: ExecutionPort,
  context: {
    authorization?: EnterpriseToolAuthorizationPort;
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    workingDirectory: string;
    traceContext: TraceContext;
  },
): ExecutionPort {
  const authorization = context.authorization;
  if (!authorization) return port;
  const authorize = async (request: ExecutionRequest, options?: ExecutionRunOptions) => {
    const cwd = request.cwd ?? context.workingDirectory;
    const signals = [options?.signal, options?.context?.abortSignal].filter(
      (value): value is AbortSignal => !!value,
    );
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const prepared = { ...request, command: structuredClone(request.command), cwd };
    let code = "enterprise_policy_unavailable";
    try {
      signal?.throwIfAborted();
      const decision = await authorization.authorize(
        {
          toolName: "NativeExecution",
          toolCallId: crypto.randomUUID(),
          sessionId: context.sessionId,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          workingDirectory: cwd,
          phase: "native_execution",
          input: { command: structuredClone(prepared.command) },
          capability: {
            permission: "bash",
            sideEffectScope: "system",
            readOnly: false,
            destructive: true,
          },
          traceContext: request.trace ?? options?.context?.trace ?? context.traceContext,
        },
        signal,
      );
      signal?.throwIfAborted();
      if (decision?.allowed === true) return { request: prepared, options: { ...options, signal } };
      if (typeof decision?.code === "string" && /^[a-z_]{1,80}$/.test(decision.code))
        code = decision.code;
    } catch {
      /* 失败不能绕过企业执行闸门，也不把原始命令或凭据拼进错误。 */
    }
    throw createCoreError(
      signal?.aborted ? CoreErrorType.ToolCancelled : CoreErrorType.PermissionDenied,
      signal?.aborted ? "enterprise_authorization_cancelled" : code,
      { recoverable: true, context: { source: "enterprise-policy" } },
    );
  };
  return {
    run: async (request, options) => {
      const prepared = await authorize(request, options);
      prepared.options.signal?.throwIfAborted();
      return port.run(prepared.request, prepared.options);
    },
    ...(port.start
      ? {
          start: async (request: ExecutionRequest, options?: ExecutionRunOptions) => {
            const prepared = await authorize(request, options);
            prepared.options.signal?.throwIfAborted();
            return port.start!(prepared.request, prepared.options);
          },
        }
      : {}),
    ...(port.getBackgroundTask ? { getBackgroundTask: port.getBackgroundTask.bind(port) } : {}),
    ...(port.readBackgroundBashOutput
      ? { readBackgroundBashOutput: port.readBackgroundBashOutput.bind(port) }
      : {}),
    ...(port.cancelBackgroundTask
      ? { cancelBackgroundTask: port.cancelBackgroundTask.bind(port) }
      : {}),
    ...(port.close ? { close: port.close.bind(port) } : {}),
  };
}
