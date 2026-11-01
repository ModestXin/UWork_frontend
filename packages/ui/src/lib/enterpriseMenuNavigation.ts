import type { EnterpriseMenu } from "@zcode/shared";
import type { OpenAutomationsMain } from "./taskNavigationHistory.js";

export interface EnterpriseMenuNavigationOwners {
  openChat(): void;
  openAutomations: OpenAutomationsMain;
  openPluginStore(): void;
  openBrowserUrl(url: string): void;
}

/** 已通过Host当前菜单准入后，legacy wire ID只分派给UWork现有所有者。 */
export function dispatchAuthorizedEnterpriseMenu(
  menu: EnterpriseMenu,
  owners: EnterpriseMenuNavigationOwners,
): void {
  if (!menu.enabled) return;
  if (!menu.builtin) {
    if (menu.url) owners.openBrowserUrl(menu.url);
    return;
  }
  if (menu.id === "chat") owners.openChat();
  else if (menu.id === "agents") owners.openAutomations();
  else if (menu.id === "assets") owners.openPluginStore();
}
