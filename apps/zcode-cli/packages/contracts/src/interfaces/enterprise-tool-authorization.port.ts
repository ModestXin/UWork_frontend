import type { ModelToolSideEffectScope } from "../model/index.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { EnterpriseAdmissionAsset } from "@zcode/shared";

export interface EnterpriseToolAuthorizationRequest {
  toolName: string;
  toolCallId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workingDirectory: string;
  input: unknown;
  phase:
    | "before_hooks"
    | "before_dispatch"
    | "before_result"
    | "native_execution"
    | "network_request"
    | "asset_load";
  asset?: EnterpriseAdmissionAsset;
  ownerKey?: string;
  capability: {
    permission: string;
    sideEffectScope: ModelToolSideEffectScope;
    readOnly: boolean;
    destructive: boolean;
    networkGuarded?: boolean;
    assetGuarded?: boolean;
  };
  traceContext: TraceContext;
}

export interface EnterpriseToolAuthorizationDecision {
  allowed: boolean;
  code: string;
  /** Managed Read / PromptAttachmentRead bind this owner at dispatch and supply it at before_result. */
  ownerKey?: string;
}

/** Trusted Host admission, independent of interactive permission modes and user grants. */
export interface EnterpriseToolAuthorizationPort {
  authorize(
    request: EnterpriseToolAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<EnterpriseToolAuthorizationDecision>;
}
