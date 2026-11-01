import {
  createToolCallId,
  type EnterpriseToolAuthorizationDecision,
  type EnterpriseToolAuthorizationPort,
  type EnterpriseToolAuthorizationRequest,
  type TraceContext,
} from "@zcode/contracts";
import type { TurnAttachment } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

interface AttachmentAuthorityScope {
  port: EnterpriseToolAuthorizationPort | undefined;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workingDirectory: string;
}

export interface PromptAttachmentAuthorizationContext {
  current: () => AttachmentAuthorityScope;
  traceContext: TraceContext;
}

export class PromptAttachmentAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(`Local attachment content withheld (${code})`);
  }
}

export function createPromptAttachmentAuthorizationContext(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): PromptAttachmentAuthorizationContext {
  return {
    current: () => ({
      port: runtime.permissionService.enterpriseAuthorization,
      sessionId: runtime.sessionId,
      workspacePath: runtime.workspaceRoot,
      workspaceIdentity: runtime.config.memory?.workspaceIdentity,
      workingDirectory: runtime.workingDirectory,
    }),
    traceContext,
  };
}

/** 只竞速原 turn 的取消；不另起权限时钟，也不让不合作端口的迟到正文继续消费。 */
export function waitForAttachment<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

export async function authorizeLocalAttachment(
  attachment: TurnAttachment,
  absolutePath: string,
  context: PromptAttachmentAuthorizationContext | undefined,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const admission = await authorizeLocalContent(
    { toolName: "PromptAttachmentRead", input: { path: absolutePath, kind: attachment.type } },
    context,
    signal,
  );
  return admission.revalidate;
}

export function authorizeProjectMemoryIndex(
  context: PromptAttachmentAuthorizationContext,
  signal?: AbortSignal,
): Promise<LocalContentAdmission> {
  return authorizeLocalContent(
    { toolName: "ProjectMemoryIndexRead", input: { kind: "project-memory-index" } },
    context,
    signal,
  );
}

export function authorizeProjectMemoryManifest(
  context: PromptAttachmentAuthorizationContext,
  signal?: AbortSignal,
): Promise<LocalContentAdmission> {
  return authorizeLocalContent(
    { toolName: "ProjectMemoryManifestRead", input: { kind: "project-memory-manifest" } },
    context,
    signal,
  );
}

interface LocalContentAdmission {
  revalidate: () => Promise<void>;
  assertCurrent: () => void;
}

async function authorizeLocalContent(
  consumer:
    | { toolName: "PromptAttachmentRead"; input: { path: string; kind: TurnAttachment["type"] } }
    | { toolName: "ProjectMemoryIndexRead"; input: { kind: "project-memory-index" } }
    | { toolName: "ProjectMemoryManifestRead"; input: { kind: "project-memory-manifest" } },
  context: PromptAttachmentAuthorizationContext | undefined,
  signal?: AbortSignal,
): Promise<LocalContentAdmission> {
  signal?.throwIfAborted();
  if (!context)
    return {
      assertCurrent: () => signal?.throwIfAborted(),
      revalidate: async () => signal?.throwIfAborted(),
    };
  const captured = context.current();
  const toolCallId = createToolCallId();
  let owner: { managed: boolean; key?: string };
  const assertCurrent = () => {
    signal?.throwIfAborted();
    const current = context.current();
    if (current.port !== captured.port)
      throw new PromptAttachmentAuthorizationError("enterprise_authority_changed");
    if (
      current.sessionId !== captured.sessionId ||
      current.workspacePath !== captured.workspacePath ||
      current.workspaceIdentity !== captured.workspaceIdentity ||
      current.workingDirectory !== captured.workingDirectory
    )
      throw new PromptAttachmentAuthorizationError("enterprise_execution_context_changed");
  };
  const proof = (decision: EnterpriseToolAuthorizationDecision) => {
    if (decision.allowed !== true)
      throw new PromptAttachmentAuthorizationError(
        /^[a-z_]{1,80}$/.test(decision.code) ? decision.code : "enterprise_policy_unavailable",
      );
    const managed = decision.code === "allowed";
    if (!managed && decision.code !== "not_managed")
      throw new PromptAttachmentAuthorizationError("enterprise_policy_unavailable");
    if (managed ? !/^[a-f0-9]{64}$/.test(decision.ownerKey ?? "") : decision.ownerKey !== undefined)
      throw new PromptAttachmentAuthorizationError("enterprise_attachment_owner_missing");
    return { managed, key: decision.ownerKey };
  };
  const authorize = async (
    phase: "before_dispatch" | "before_result",
  ): Promise<{ managed: boolean; key?: string }> => {
    assertCurrent();
    if (!captured.port) return { managed: false };
    const request: EnterpriseToolAuthorizationRequest = {
      toolName: consumer.toolName,
      toolCallId,
      sessionId: captured.sessionId,
      workspacePath: captured.workspacePath,
      ...(captured.workspaceIdentity ? { workspaceIdentity: captured.workspaceIdentity } : {}),
      workingDirectory: captured.workingDirectory,
      input: consumer.input,
      phase,
      ...(phase === "before_result" && owner.key ? { ownerKey: owner.key } : {}),
      capability: {
        permission: "filesystem",
        sideEffectScope: "none",
        readOnly: true,
        destructive: false,
      },
      traceContext: context.traceContext,
    };
    try {
      const decision = await waitForAttachment(captured.port.authorize(request, signal), signal);
      assertCurrent();
      return proof(decision);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof PromptAttachmentAuthorizationError) throw error;
      throw new PromptAttachmentAuthorizationError("enterprise_policy_unavailable");
    }
  };
  owner = await authorize("before_dispatch");
  return {
    assertCurrent,
    revalidate: async () => {
      const currentOwner = await authorize("before_result");
      if (currentOwner.managed !== owner.managed || currentOwner.key !== owner.key)
        throw new PromptAttachmentAuthorizationError("enterprise_identity_changed");
    },
  };
}
