import { z } from "zod";
import { enterpriseMenuSchema } from "@zcode/shared";
import type { UWorkBackendScope } from "../../enterprise-identity/backendSessionContract.js";

export function consoleUnavailable(): never {
  throw new Error("enterprise_console_unavailable");
}
/** Agent权限属于执行渠道，不能跟映射到Automation的导航菜单混为同一裁决。 */
export async function authorizeConsoleAgents(scope: UWorkBackendScope) {
  const response = await scope.request("/api/client/authorize", {
    action: "execution",
    channel: "agents",
  });
  const decision = z
    .object({ allowed: z.literal(true), tenantId: z.string() })
    .safeParse(response.body);
  if (response.status !== 200 || !decision.success || decision.data.tenantId !== scope.tenantId)
    consoleUnavailable();
  await scope.assertCurrent();
}
export async function authorizeConsoleMenu(scope: UWorkBackendScope, id: string) {
  const response = await scope.request(
    `/api/client/menus/${encodeURIComponent(id)}/authorize`,
    {},
    { method: "POST" },
  );
  const decision = z
    .object({
      allowed: z.literal(true),
      tenantId: z.string(),
      menu: enterpriseMenuSchema,
      version: z.number().int().nonnegative(),
    })
    .safeParse(response.body);
  if (
    response.status !== 200 ||
    !decision.success ||
    decision.data.tenantId !== scope.tenantId ||
    decision.data.menu.id !== id ||
    !decision.data.menu.enabled
  )
    consoleUnavailable();
  await scope.assertCurrent();
  return decision.data.menu;
}
