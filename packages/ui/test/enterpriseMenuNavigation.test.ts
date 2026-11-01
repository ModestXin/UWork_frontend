import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnterpriseMenu } from "@zcode/shared";
import { dispatchAuthorizedEnterpriseMenu } from "../src/lib/enterpriseMenuNavigation.js";

test("legacy agents/assets IDs call existing Automation/Plugin Store owners without enterprise resource operations", () => {
  const calls: string[] = [];
  const owners = {
    openChat: () => calls.push("chat"),
    openAutomations: () => calls.push("automations"),
    openPluginStore: () => calls.push("plugin-store"),
    openBrowserUrl: (url: string) => calls.push(url),
  };
  const menu = (id: string, builtin = true): EnterpriseMenu => ({
    id,
    builtin,
    enabled: true,
    name: "Custom team label",
    nameEn: "Custom label",
    icon: "globe",
    ...(!builtin ? { url: "https://portal.example.test/" } : {}),
  });
  for (const id of ["agents", "assets", "chat"]) dispatchAuthorizedEnterpriseMenu(menu(id), owners);
  dispatchAuthorizedEnterpriseMenu(menu("portal", false), owners);
  assert.deepEqual(calls, ["automations", "plugin-store", "chat", "https://portal.example.test/"]);
  dispatchAuthorizedEnterpriseMenu({ ...menu("agents"), enabled: false }, owners);
  dispatchAuthorizedEnterpriseMenu(menu("unknown"), owners);
  assert.equal(calls.length, 4);
});
test("published legacy titles remain unchanged while IDs route to existing UWork owners", () => {
  const menu: EnterpriseMenu = {
    id: "agents",
    builtin: true,
    enabled: true,
    name: "智能体",
    nameEn: "Agents",
    icon: "bot",
  };
  const before = JSON.stringify(menu),
    calls: string[] = [];
  dispatchAuthorizedEnterpriseMenu(menu, {
    openChat: () => calls.push("chat"),
    openAutomations: () => calls.push("automations"),
    openPluginStore: () => calls.push("plugin-store"),
    openBrowserUrl: () => calls.push("browser"),
  });
  assert.deepEqual(calls, ["automations"]);
  assert.equal(JSON.stringify(menu), before);
});
