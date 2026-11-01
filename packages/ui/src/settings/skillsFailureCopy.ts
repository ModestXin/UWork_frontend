export function resolveSkillsFailureMessageId(error: string): string | undefined {
  // 原生实测的权限拒绝曾被误报为不支持桌面；只翻译完整稳定码，不猜测能力。
  if (error === "enterprise_personal_skills_denied")
    return "settings.skills.enterprisePolicyDenied";
  if (error === "enterprise_filesystem_denied") return "settings.skills.enterpriseFilesystemDenied";
  if (error === "enterprise_policy_unavailable")
    return "settings.skills.enterprisePolicyUnavailable";
  if (
    error === "enterprise_runtime_obsolete" ||
    error === "enterprise_identity_changed" ||
    error === "enterprise_configuration_changed"
  )
    return "settings.skills.enterpriseRuntimeChanged";
  return undefined;
}
