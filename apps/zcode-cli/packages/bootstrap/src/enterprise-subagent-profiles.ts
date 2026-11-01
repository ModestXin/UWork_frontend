import { PERSONAL_AGENT_PROFILE_PREFIX, type AgentProfile } from "@zcode/core";
import type { EnterpriseExpertProfileOutcome } from "./enterprise-experts.js";

/** 纯组合不持有权限；只消费同次目录事实，原 Core registry 仍是 profile 唯一所有者。 */
export function composeEnterpriseSubagentProfiles(input: {
  outcome?: EnterpriseExpertProfileOutcome;
  local: readonly AgentProfile[];
  plugins: readonly AgentProfile[];
  injected: readonly AgentProfile[];
}): AgentProfile[] {
  const { outcome } = input;
  if (!outcome?.managed)
    return [...input.injected, ...input.local, ...input.plugins, ...(outcome?.profiles ?? [])];
  if (!outcome.personalProfilesAllowed) return [...outcome.profiles];
  const qualify = (
    profile: AgentProfile,
    origin: "user" | "project" | "plugin" | "runtime",
  ): AgentProfile => ({
    ...profile,
    name: `${PERSONAL_AGENT_PROFILE_PREFIX}${origin}:${profile.name}`,
    // runtime/插件自报 enterprise 或 built-in 不能制造准入豁免。
    source: origin === "project" ? "project" : "user",
    exactSelection: true,
  });
  return [
    ...input.injected.map((profile) => qualify(profile, "runtime")),
    ...input.local.map((profile) =>
      qualify(profile, profile.source === "project" ? "project" : "user"),
    ),
    ...input.plugins.map((profile) => qualify(profile, "plugin")),
    ...outcome.profiles,
  ];
}
