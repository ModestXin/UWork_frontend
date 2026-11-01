import {
  CoreErrorType,
  createCoreError,
  type EnterpriseToolAuthorizationRequest,
  type EnterpriseToolAuthorizationDecision,
  type EnterpriseToolAuthorizationPort,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { createErrorResult } from "./errors.js";
import { emitPermissionDenied, emitToolCallError } from "./events.js";

export interface EnterpriseExecutionScope {
  workingDirectory: string;
  workspaceRoot: string;
  workspaceIdentity?: string;
}

export interface EnterpriseReadResultAuthority {
  readonly port: EnterpriseToolAuthorizationPort | undefined;
  owner?: { managed: boolean; key?: string };
}

export function captureEnterpriseReadResultAuthority(
  deps: ToolExecutorDeps,
  entry: ToolEntry,
): EnterpriseReadResultAuthority | undefined {
  return entry.metadata.name === "Read" &&
    !entry.metadata.mcpPresentation &&
    entry.permission.permission === "read" &&
    entry.metadata.readOnly &&
    !entry.metadata.destructive &&
    entry.permission.sideEffectScope === "none"
    ? { port: deps.permissionService.enterpriseAuthorization }
    : undefined;
}

function bindReadDecision(
  authority: EnterpriseReadResultAuthority,
  decision: EnterpriseToolAuthorizationDecision,
  phase: EnterpriseToolAuthorizationRequest["phase"],
): string | undefined {
  const managed = decision.code === "allowed";
  if (!managed && decision.code !== "not_managed") return "enterprise_policy_unavailable";
  if (managed ? !/^[a-f0-9]{64}$/.test(decision.ownerKey ?? "") : decision.ownerKey !== undefined)
    return "enterprise_read_owner_missing";
  if (phase === "before_dispatch") authority.owner = { managed, key: decision.ownerKey };
  else if (
    !authority.owner ||
    authority.owner.managed !== managed ||
    authority.owner.key !== decision.ownerKey
  )
    return "enterprise_identity_changed";
  return undefined;
}

export function captureEnterpriseExecutionScope(deps: ToolExecutorDeps): EnterpriseExecutionScope {
  return {
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
    workspaceIdentity: deps.workspaceIdentity,
  };
}
export function matchesEnterpriseExecutionScope(
  deps: ToolExecutorDeps,
  scope: EnterpriseExecutionScope,
) {
  const current = captureEnterpriseExecutionScope(deps);
  return (
    current.workingDirectory === scope.workingDirectory &&
    current.workspaceRoot === scope.workspaceRoot &&
    current.workspaceIdentity === scope.workspaceIdentity
  );
}
export function snapshotEnterpriseInput(input: unknown): unknown {
  try {
    return structuredClone(input);
  } catch {
    throw createCoreError(CoreErrorType.PermissionDenied, "enterprise_input_unsupported", {
      recoverable: true,
    });
  }
}

export async function emitEnterpriseToolDenial(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  traceContext: TraceContext,
  result: ToolExecutionResult,
): Promise<void> {
  await emitPermissionDenied(
    deps,
    toolCall,
    result.error?.message ?? "Enterprise authorization denied",
    traceContext,
  );
  await emitToolCallError(
    deps,
    toolCall.id,
    traceContext,
    traceContext.turnId ?? deps.turnId,
    result.error,
  );
}

export async function authorizeEnterpriseTool(input: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  toolCall: ExecutableToolCall;
  executionInput: unknown;
  scope: EnterpriseExecutionScope;
  traceContext: TraceContext;
  phase: EnterpriseToolAuthorizationRequest["phase"];
  signal?: AbortSignal;
  readResultAuthority?: EnterpriseReadResultAuthority;
  deferFailureEvents?: boolean;
}): Promise<ToolExecutionResult | undefined> {
  const binding = input.readResultAuthority;
  const port = binding ? binding.port : input.deps.permissionService.enterpriseAuthorization;
  let code = "enterprise_policy_unavailable";
  try {
    input.signal?.throwIfAborted();
    // Read 等待期间端口可能消失或换人；必须使用原端口，不能从当前服务重新抓一个 allow。
    if (binding && port !== input.deps.permissionService.enterpriseAuthorization) {
      code = "enterprise_authority_changed";
      throw Error(code);
    }
    if (!port) return undefined;
    // 企业裁决读取静态注册能力，不把 Bash 的只读优化或 MCP 注解升级成安全豁免。
    const decision = await port.authorize(
      {
        toolName: input.entry.metadata.name,
        toolCallId: input.toolCall.id,
        sessionId: input.deps.sessionId,
        workspacePath: input.scope.workspaceRoot,
        workspaceIdentity: input.scope.workspaceIdentity,
        workingDirectory: input.scope.workingDirectory,
        input: snapshotEnterpriseInput(input.executionInput),
        phase: input.phase,
        ...(input.phase === "before_result" && binding?.owner?.key
          ? { ownerKey: binding.owner.key }
          : {}),
        capability: {
          permission: input.entry.metadata.mcpPresentation
            ? "mcp"
            : input.entry.permission.permission,
          sideEffectScope: input.entry.permission.sideEffectScope,
          readOnly: input.entry.metadata.readOnly,
          destructive: input.entry.metadata.destructive,
          networkGuarded: input.deps.httpClientPort?.enterpriseNetworkGuarded === true,
          assetGuarded:
            input.entry.metadata.name === "Skill" &&
            !input.entry.metadata.mcpPresentation &&
            input.deps.skillPort?.enterpriseAssetGuarded === true,
        },
        traceContext: input.traceContext,
      },
      input.signal,
    );
    input.signal?.throwIfAborted();
    if (binding && port !== input.deps.permissionService.enterpriseAuthorization)
      code = "enterprise_authority_changed";
    else if (!matchesEnterpriseExecutionScope(input.deps, input.scope))
      code = "enterprise_execution_context_changed";
    else if (decision?.allowed === true) {
      const failure = binding ? bindReadDecision(binding, decision, input.phase) : undefined;
      if (!failure) return undefined;
      code = failure;
    } else if (typeof decision?.code === "string" && /^[a-z_]{1,80}$/.test(decision.code))
      code = decision.code;
  } catch {
    /* 外部身份/网络异常不能泄露请求或凭据，也不能回退到 yolo 放行。 */
  }
  const cancelled = input.signal?.aborted === true;
  const withheld = input.phase === "before_result";
  const reason = cancelled ? "enterprise_authorization_cancelled" : code;
  const error = createCoreError(
    cancelled ? CoreErrorType.ToolCancelled : CoreErrorType.PermissionDenied,
    withheld
      ? `Read completed; content withheld (${reason})`
      : cancelled
        ? "Enterprise authorization cancelled"
        : code,
    {
      context: {
        code: reason,
        source: "enterprise-policy",
        ...(withheld ? { handlerExecuted: true, resultWithheld: true } : {}),
      },
      recoverable: !withheld,
    },
  );
  const result = createErrorResult(input.toolCall, error);
  if (!input.deferFailureEvents)
    await emitEnterpriseToolDenial(input.deps, input.toolCall, input.traceContext, result);
  return result;
}
