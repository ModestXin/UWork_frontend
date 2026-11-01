import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  type EnterpriseToolAuthorizationDecision,
  type EnterpriseToolAuthorizationPort,
  type Model,
  type ModelRequest,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentProfile } from "./profile.js";

export interface PersonalAgentAuthorizationContext {
  authorization?: EnterpriseToolAuthorizationPort;
  profile: Pick<AgentProfile, "name" | "source">;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workingDirectory: string;
  traceContext: TraceContext;
  signal?: AbortSignal;
  /** 仅绑定本次个人内容读取的身份；每次模型请求仍重新裁决权限。 */
  expectedOwnerKey?: string;
  expectedManaged?: boolean;
}

function needsPersonalAdmission(input: PersonalAgentAuthorizationContext): boolean {
  return input.profile.source === "user" || input.profile.source === "project";
}

export async function authorizePersonalAgentProfile(
  input: PersonalAgentAuthorizationContext,
): Promise<EnterpriseToolAuthorizationDecision | undefined> {
  if (!needsPersonalAdmission(input) || !input.authorization) return undefined;
  let code = "enterprise_policy_unavailable";
  try {
    input.signal?.throwIfAborted();
    const decision = await input.authorization.authorize(
      {
        toolName: "PersonalAgentProfileLoad",
        toolCallId: crypto.randomUUID(),
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
        workingDirectory: input.workingDirectory,
        input: {},
        phase: "before_dispatch",
        capability: {
          permission: "personal_agent",
          sideEffectScope: "none",
          readOnly: true,
          destructive: false,
        },
        traceContext: input.traceContext,
      },
      input.signal,
    );
    input.signal?.throwIfAborted();
    if (decision.allowed) {
      const managed = decision.code !== "not_managed";
      if (managed && !decision.ownerKey) code = "enterprise_policy_unavailable";
      else if (
        (input.expectedManaged !== undefined && input.expectedManaged !== managed) ||
        (input.expectedOwnerKey !== undefined && decision.ownerKey !== input.expectedOwnerKey)
      )
        code = "enterprise_identity_changed";
      else return decision;
    } else if (/^enterprise_[a-z_]{1,64}$/.test(decision.code)) code = decision.code;
  } catch {
    // 身份/网络异常只能产生稳定拒绝，不能泄露私有错误或回落到个人模式。
  }
  const cancelled = input.signal?.aborted === true;
  code = cancelled ? "enterprise_authorization_cancelled" : code;
  throw createCoreError(
    cancelled ? CoreErrorType.ToolCancelled : CoreErrorType.PermissionDenied,
    code,
    { context: { code, source: "enterprise-policy" }, recoverable: true },
  );
}

export function withPersonalAgentModelAuthorization(
  model: Model,
  input: PersonalAgentAuthorizationContext,
): Model {
  if (!needsPersonalAdmission(input) || !input.authorization) return model;
  const context = { ...input, profile: { ...input.profile } };
  const admit = (request: ModelRequest) => {
    const signals = [context.signal, request.abortSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    return authorizePersonalAgentProfile({
      ...context,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? context.traceContext,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
  };
  // 继承/override/factory 产出的每个 Model 都经过同一入口；bind 不丢准入。
  return Object.freeze({
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withPersonalAgentModelAuthorization(model.bind(options), context);
    },
    async generateText(request) {
      await admit(request);
      return model.generateText(request);
    },
    async *streamText(request) {
      await admit(request);
      yield* model.streamText(request);
    },
  } satisfies Model);
}
