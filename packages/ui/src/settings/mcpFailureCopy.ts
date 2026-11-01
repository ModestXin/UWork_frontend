import type { McpServerFailureKind } from "@zcode/shared";

const POLICY_DENIALS = new Set([
  "enterprise_personal_connectors_denied",
  "enterprise_shell_denied",
  "enterprise_filesystem_denied",
  "enterprise_network_denied",
  "enterprise_domain_denied",
]);

export function resolveMcpFailureMessageId(
  failureKind: McpServerFailureKind | undefined,
  error?: string,
):
  | `settings.mcp.failure.${McpServerFailureKind}`
  | "settings.mcp.failure.enterprisePolicyDenied"
  | "settings.mcp.failure.enterpriseRuntimeChanged"
  | "settings.mcp.failure.enterprisePolicyUnavailable" {
  // 企业准入拒绝不是网络故障；只匹配完整稳定码，不改写任意上游正文。
  if (error !== undefined && POLICY_DENIALS.has(error))
    return "settings.mcp.failure.enterprisePolicyDenied";
  if (
    error === "enterprise_runtime_obsolete" ||
    error === "enterprise_identity_changed" ||
    error === "enterprise_configuration_changed"
  )
    return "settings.mcp.failure.enterpriseRuntimeChanged";
  if (error === "enterprise_policy_unavailable")
    return "settings.mcp.failure.enterprisePolicyUnavailable";
  return `settings.mcp.failure.${failureKind ?? "connection_failed"}`;
}
