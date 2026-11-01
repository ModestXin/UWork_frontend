import { z } from "zod";
import { zcodeEnterpriseToolAuthorizationParamsSchema } from "@zcode/shared";
import type {
  ZCodeEnterpriseToolAuthorizationParams,
  ZCodeEnterpriseToolAuthorizationResult,
} from "@zcode/shared";
import {
  uworkSecuritySchema as securitySchema,
  UWorkBackendSessionError,
  type UWorkBackendSession,
  type UWorkBackendSessionOptions,
} from "./backendSessionContract.js";
import { createUWorkBackendSession } from "./uworkBackendSession.js";
const SESSION_PERMISSIONS = new Set([
  "subagent",
  "todo.read",
  "todo.write",
  "userInteraction.askQuestion",
  "backgroundTask.stop",
  "taskOutput",
  "listModels",
  "plan.enter",
  "plan.exit",
  "session.context.read",
  "agent.message.send",
  "agent.message.respond",
  "workflow.submitResult",
  "workflow.escalate",
  "automation.read",
  "offpeak.read",
]);
const denied = (code: string): ZCodeEnterpriseToolAuthorizationResult => ({ allowed: false, code });

function evaluate(
  request: ZCodeEnterpriseToolAuthorizationParams,
  security: z.infer<typeof securitySchema>,
  personal: { models: boolean; skills?: boolean; connectors: boolean } | undefined,
  backendOrigin: string,
): ZCodeEnterpriseToolAuthorizationResult {
  const { permission, sideEffectScope } = request.capability;
  if (permission === "model_request") {
    const target = z.object({ url: z.string().max(4096) }).safeParse(request.input);
    if (!target.success) return denied("enterprise_model_target_invalid");
    let url: URL;
    try {
      url = new URL(target.data.url);
    } catch {
      return denied("enterprise_model_target_invalid");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      return denied("enterprise_model_target_invalid");
    // 托管身份取当前私有issuer与实际出口，Provider名称/Renderer标记不能制造豁免。
    if (url.origin === backendOrigin && /^\/v1(?:\/|$)/.test(url.pathname))
      return { allowed: true, code: "allowed" };
    if (personal?.models !== true) return denied("enterprise_personal_models_denied");
    if (!security.allowNetwork) return denied("enterprise_network_denied");
    if (security.allowedDomains.length && !security.allowedDomains.includes(url.hostname))
      return denied("enterprise_domain_denied");
    return { allowed: true, code: "allowed" };
  }
  if (permission === "personal_connector" && personal?.connectors !== true)
    return denied("enterprise_personal_connectors_denied");
  // 已解析的个人子智能体提示词与本地技能一样，不能借 Agent 的会话能力绕过个人开关。
  if (permission === "personal_agent") {
    if (personal?.skills !== true) return denied("enterprise_personal_agents_denied");
    if (!security.allowFilesystem) return denied("enterprise_filesystem_denied");
    if (!security.dangerousSkills) return denied("enterprise_personal_agents_denied");
  }
  const native =
    request.phase === "native_execution" ||
    request.toolName === "Bash" ||
    permission === "bash" ||
    permission === "node_repl" ||
    sideEffectScope === "system" ||
    permission === "mcp" ||
    permission === "personal_connector";
  if (native) {
    if (!security.allowShell) return denied("enterprise_shell_denied");
    if (!security.allowFilesystem || !security.allowNetwork || security.allowedDomains.length > 0)
      return denied("enterprise_capability_unsupported");
  }
  const filesystem =
    [
      "read",
      "edit",
      "filesystem",
      "skill",
      "personal_agent",
      "listSavedWorkflows",
      "listWorkflowRuns",
      "getWorkflowRun",
    ].includes(permission) ||
    ["Read", "Write", "Edit", "ApplyPatch", "Glob", "Grep", "Skill"].includes(request.toolName) ||
    ["workspace", "git"].includes(sideEffectScope);
  if (filesystem && !security.allowFilesystem) return denied("enterprise_filesystem_denied");
  if (
    (permission === "skill" || request.toolName === "Skill") &&
    !security.dangerousSkills &&
    request.capability.assetGuarded !== true
  )
    return denied("enterprise_capability_unsupported");
  const network =
    sideEffectScope === "network" ||
    permission === "network" ||
    ["WebFetch", "WebSearch"].includes(request.toolName);
  if (network) {
    if (!security.allowNetwork) return denied("enterprise_network_denied");
    const value =
      request.input && typeof request.input === "object"
        ? (request.input as Record<string, unknown>).url
        : undefined;
    if (security.allowedDomains.length) {
      if (typeof value !== "string") return denied("enterprise_capability_unsupported");
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return denied("enterprise_domain_denied");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !security.allowedDomains.includes(url.hostname)
      )
        return denied("enterprise_domain_denied");
      if (
        request.capability.networkGuarded !== true ||
        (request.toolName !== "WebFetch" && request.phase !== "network_request")
      )
        return denied("enterprise_capability_unsupported");
    }
  }
  if (!native && !filesystem && !network && !SESSION_PERMISSIONS.has(permission))
    return denied("enterprise_capability_unsupported");
  return { allowed: true, code: "allowed" };
}

export function createUWorkToolAuthorizationResolver(
  options: UWorkBackendSessionOptions | { backendSession: UWorkBackendSession },
) {
  const backendSession =
    "backendSession" in options ? options.backendSession : createUWorkBackendSession(options);
  return {
    async authorize(
      request: ZCodeEnterpriseToolAuthorizationParams,
      signal?: AbortSignal,
      traceId?: string,
    ): Promise<ZCodeEnterpriseToolAuthorizationResult> {
      if (request.phase === "asset_load") return denied("enterprise_capability_unsupported");
      const attachmentRead = request.toolName === "PromptAttachmentRead";
      const memoryIndexRead = request.toolName === "ProjectMemoryIndexRead";
      const memoryManifestRead = request.toolName === "ProjectMemoryManifestRead";
      // 只窄开固定内部正文消费者；Memory 开关不能绕过企业文件权限或 owner 复核。
      if (
        (attachmentRead || memoryIndexRead || memoryManifestRead) &&
        !zcodeEnterpriseToolAuthorizationParamsSchema.safeParse(request).success
      )
        return denied("enterprise_capability_unsupported");
      const builtinRead =
        request.toolName === "Read" &&
        request.capability.permission === "read" &&
        request.capability.readOnly &&
        !request.capability.destructive &&
        request.capability.sideEffectScope === "none";
      if (
        request.phase === "before_result" &&
        !builtinRead &&
        !attachmentRead &&
        !memoryIndexRead &&
        !memoryManifestRead
      )
        return denied("enterprise_capability_unsupported");
      try {
        const result = await backendSession.run(
          async (scope) => {
            // 新读取的正文属于原准入 owner；不能借新成员的有效 allow 释放旧正文。
            if (request.phase === "before_result" && request.ownerKey !== scope.ownerKey)
              return denied("enterprise_identity_changed");
            const response = await scope.request("/api/client/authorize", {
              action: "execution",
              channel: "local",
            });
            if (response.status < 200 || response.status >= 300)
              return denied(
                response.status === 402
                  ? "enterprise_subscription_inactive"
                  : "enterprise_policy_unavailable",
              );
            const parsed = z
              .object({
                allowed: z.literal(true),
                tenantId: z.string(),
                security: securitySchema,
                personal: z
                  .object({
                    models: z.boolean(),
                    skills: z.boolean().optional(),
                    connectors: z.boolean(),
                  })
                  .optional(),
              })
              .safeParse(response.body);
            if (!parsed.success || parsed.data.tenantId !== scope.tenantId)
              return denied("enterprise_policy_unavailable");
            const decision = evaluate(
              request,
              parsed.data.security,
              parsed.data.personal,
              scope.origin,
            );
            return decision.allowed &&
              (builtinRead ||
                ["model_request", "personal_connector", "personal_agent", "filesystem"].includes(
                  request.capability.permission,
                ) ||
                request.toolName === "McpDispatch")
              ? { ...decision, ownerKey: scope.ownerKey }
              : decision;
          },
          { signal, traceId },
        );
        return result.managed
          ? result.value
          : request.phase === "before_result" && request.ownerKey !== undefined
            ? denied("enterprise_identity_changed")
            : { allowed: true, code: "not_managed" };
      } catch (error) {
        if (signal?.aborted) return denied("enterprise_authorization_cancelled");
        return denied(
          error instanceof UWorkBackendSessionError &&
            [
              "enterprise_identity_changed",
              "enterprise_configuration_changed",
              "enterprise_authorization_cancelled",
            ].includes(error.code)
            ? error.code
            : "enterprise_policy_unavailable",
        );
      }
    },
  };
}
