import type { ConversationShareAccessMode } from "@zcode/shared";

export type ConversationSharePermission =
  | "organization"
  | "private"
  | "link-viewer"
  | "link-editor";
export const LEGACY_CONVERSATION_SHARE_ACCESS_MODES: readonly ConversationShareAccessMode[] = [
  "private",
  "public_readonly",
  "public_importable",
];
const permissions: Record<ConversationShareAccessMode, ConversationSharePermission> = {
  organization: "organization",
  private: "private",
  public_readonly: "link-viewer",
  public_importable: "link-editor",
};
const modes: Record<ConversationSharePermission, ConversationShareAccessMode> = {
  organization: "organization",
  private: "private",
  "link-viewer": "public_readonly",
  "link-editor": "public_importable",
};
export const accessModeToPermission = (
  mode: ConversationShareAccessMode,
): ConversationSharePermission => permissions[mode];
export const permissionToAccessMode = (
  permission: ConversationSharePermission,
): ConversationShareAccessMode => modes[permission];
/** 能力未知时不能将组织模式落为 private/public；调用方应禁用发布。 */
export function resolveConversationShareAccessMode(
  current: ConversationShareAccessMode,
  available: readonly ConversationShareAccessMode[],
): ConversationShareAccessMode | undefined {
  return available.includes(current)
    ? current
    : available.includes("organization")
      ? "organization"
      : available[0];
}
