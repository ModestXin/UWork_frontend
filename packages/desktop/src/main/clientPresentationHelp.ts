import type { BoundClientPresentation } from "./clientPresentationBindings.js";

/** true 包括 managed 的显式关闭/不可用，调用方不得因此回退旧帮助。 */
export async function openBoundClientHelp(options: {
  senderId: number;
  kind: "community" | "feedback";
  locale: string;
  read(senderId: number): Promise<BoundClientPresentation>;
  isCurrent(senderId: number, epoch: string): boolean;
  open(url: string): Promise<unknown>;
}): Promise<boolean> {
  const bound = await options.read(options.senderId);
  if (!options.isCurrent(options.senderId, bound.bindingEpoch)) return true;
  const projection = bound.projection;
  if (projection.status === "unmanaged") return false;
  if (projection.status !== "ready" || projection.help.status !== "ready") return true;
  const help = projection.help.data;
  const url =
    options.kind === "feedback"
      ? help.feedback.mode === "external"
        ? help.feedback.url
        : null
      : help.communityUrls[options.locale.startsWith("zh") ? "zh-CN" : "en-US"];
  if (url && options.isCurrent(options.senderId, bound.bindingEpoch)) await options.open(url);
  return true;
}
