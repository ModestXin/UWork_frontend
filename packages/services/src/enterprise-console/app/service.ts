import { z } from "zod";
import {
  enterpriseNavigationSchema,
  enterpriseMenuSchema,
  enterpriseAgentSchema,
  enterpriseRunSchema,
  enterpriseRunPageSchema,
  enterpriseAssetMetadataSchema,
} from "@zcode/shared";
import type {
  UWorkBackendSession,
  UWorkBackendScope,
} from "../../enterprise-identity/backendSessionContract.js";
import type { IEnterpriseConsoleService } from "../contract.js";
import { authorizeConsoleMenu, authorizeConsoleAgents, consoleUnavailable } from "./backend.js";

const identifier = z.string().min(1).max(256);
export function createEnterpriseConsoleService(
  backend: UWorkBackendSession,
): IEnterpriseConsoleService {
  const managed = async <T>(operation: (scope: UWorkBackendScope) => Promise<T>): Promise<T> => {
    try {
      const result = await backend.run(operation);
      return result.managed ? result.value : consoleUnavailable();
    } catch {
      return consoleUnavailable();
    }
  };
  const read = async <T>(channel: "agents" | undefined, path: string, schema: z.ZodType<T>) =>
    managed(async (scope) => {
      if (channel) await authorizeConsoleAgents(scope);
      const response = await scope.request(path);
      if (response.status < 200 || response.status >= 300) consoleUnavailable();
      const parsed = schema.parse(response.body);
      if (channel) await authorizeConsoleAgents(scope);
      await scope.assertCurrent();
      return parsed;
    });
  return {
    async getNavigation() {
      try {
        const result = await backend.run(async (scope) => {
          const response = await scope.request("/api/client/configuration");
          const parsed = z
            .object({
              tenantId: z.string(),
              versions: z.object({ menus: z.number().int().nonnegative() }),
              configuration: z.object({
                menus: z.object({ items: z.array(enterpriseMenuSchema).max(50) }),
              }),
            })
            .parse(response.body);
          if (response.status !== 200 || parsed.tenantId !== scope.tenantId) consoleUnavailable();
          if (
            new Set(parsed.configuration.menus.items.map((item) => item.id)).size !==
            parsed.configuration.menus.items.length
          )
            consoleUnavailable();
          await scope.assertCurrent();
          return enterpriseNavigationSchema.parse({
            status: "ready",
            version: parsed.versions.menus,
            items: parsed.configuration.menus.items.filter((menu) => menu.enabled),
          });
        });
        return result.managed ? result.value : { status: "unmanaged" };
      } catch {
        return { status: "unavailable" };
      }
    },
    authorizeMenu: (id) => managed((scope) => authorizeConsoleMenu(scope, identifier.parse(id))),
    listAgents: async () =>
      (
        await read(
          "agents",
          "/api/client/agents",
          z.object({ items: z.array(enterpriseAgentSchema).max(1000) }),
        )
      ).items,
    listAssets: async () =>
      (
        await read(
          undefined,
          "/api/client/assets",
          z.object({ items: z.array(enterpriseAssetMetadataSchema).max(1000) }),
        )
      ).items,
    listRuns: (page) =>
      read(
        "agents",
        `/api/client/runs?page=${z.number().int().min(1).max(100000).parse(page)}&pageSize=25`,
        enterpriseRunPageSchema,
      ),
    createRun: (input) =>
      managed(async (scope) => {
        const payload = z
          .object({ agentId: identifier, input: z.string().min(1).max(100000) })
          .strict()
          .parse(input);
        await authorizeConsoleAgents(scope);
        const response = await scope.request("/api/client/runs", payload, { method: "POST" });
        if (response.status !== 202) consoleUnavailable();
        const receipt = enterpriseRunSchema
          .omit({ input: true, output: true })
          .strip()
          .parse(response.body);
        // 202 是后端已接受的事实。后续菜单关闭不能丢掉停止句柄或误报未受理。
        await scope.assertCurrent();
        return receipt;
      }),
    readRun: (id) =>
      read(
        "agents",
        `/api/client/runs/${encodeURIComponent(identifier.parse(id))}`,
        enterpriseRunSchema,
      ),
    cancelRun: async (id) => {
      await managed(async (scope) => {
        // 菜单撤销不能锁住已接受任务的停止入口；后端仍检查当前席位、订阅和本人归属。
        const response = await scope.request(
          `/api/client/runs/${encodeURIComponent(identifier.parse(id))}/cancel`,
          {},
          { method: "POST" },
        );
        if (response.status !== 200) consoleUnavailable();
        z.object({ ok: z.literal(true) })
          .strict()
          .parse(response.body);
        await scope.assertCurrent();
      });
    },
  };
}
