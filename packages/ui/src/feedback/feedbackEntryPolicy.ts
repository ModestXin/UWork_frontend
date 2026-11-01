import type { UWorkClientPresentation } from "@zcode/shared";

export type FeedbackEntryPolicy = "legacy" | "external" | "disabled" | "unavailable";

export function resolveFeedbackEntryPolicy(
  presentation: UWorkClientPresentation | null,
): FeedbackEntryPolicy {
  if (presentation?.status === "unmanaged") return "legacy";
  if (presentation?.status !== "ready" || presentation.help.status !== "ready")
    return "unavailable";
  return presentation.help.data.feedback.mode === "external" ? "external" : "disabled";
}
