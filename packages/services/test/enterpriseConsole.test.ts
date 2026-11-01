import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnterpriseConsoleService } from "../src/enterprise-console/module.js";
import type {
  UWorkBackendScope,
  UWorkBackendSession,
} from "../src/enterprise-identity/backendSessionContract.js";

function fixture() {
  let enabled = true,
    active = true,
    managed = true,
    invalidateRead = false,
    invalidateOperation = false,
    revokeChannelAfterRead = false;
  let channelAllowed = true,
    apiAllowed = true;
  let agents: unknown = { items: [{ id: "agent", name: "Controlled", publishedVersion: 1 }] };
  const menu = {
    id: "agents",
    name: "自动化",
    nameEn: "Automations",
    enabled: true,
    builtin: true,
    icon: "bot",
  };
  const receipt = {
    id: "run",
    agentId: "agent",
    sessionId: "session",
    status: "queued",
    errorCode: null,
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
  };
  const paths: string[] = [];
  const scope: UWorkBackendScope = {
    ownerKey: "controlled-owner",
    origin: "https://controlled.example.test",
    tenantId: "tenant",
    memberId: "member",
    signal: new AbortController().signal,
    isCurrent: () => active,
    assertCurrent: async () => {
      if (!active) throw new Error("owner_changed");
    },
    async request(path, body, options) {
      paths.push(path);
      if (path === "/api/client/configuration") {
        if (invalidateRead) active = false;
        return {
          status: 200,
          body: {
            tenantId: "tenant",
            versions: { menus: 0 },
            configuration: { menus: { items: [{ ...menu, enabled }] } },
          },
        };
      }
      if (path === "/api/client/authorize") {
        assert.deepEqual(body, { action: "execution", channel: "agents" });
        return { status: 200, body: { allowed: channelAllowed, tenantId: "tenant" } };
      }
      if (path.endsWith("/authorize"))
        return {
          status: 200,
          body: { allowed: enabled, tenantId: "tenant", version: 0, ...(enabled ? { menu } : {}) },
        };
      if (!apiAllowed) return { status: 403, body: { error: "permission_denied" } };
      if (path === "/api/client/agents") {
        if (invalidateOperation) active = false;
        if (revokeChannelAfterRead) channelAllowed = false;
        return { status: 200, body: agents };
      }
      if (path === "/api/client/assets") return { status: 200, body: { items: [] } };
      if (path.startsWith("/api/client/runs?"))
        return { status: 200, body: { items: [receipt], page: 1, pageSize: 25, total: 1 } };
      if (path === "/api/client/runs" && options?.method === "POST") {
        assert.deepEqual(body, { agentId: "agent", input: "controlled input" });
        enabled = false;
        return {
          status: 202,
          body: { ...receipt, input: "private input", output: "never in accepted receipt" },
        };
      }
      if (path === "/api/client/runs/run")
        return { status: 200, body: { ...receipt, output: "caller-owned result" } };
      if (path.endsWith("/cancel")) return { status: 200, body: { ok: true } };
      throw new Error("unexpected request");
    },
  };
  const backend: UWorkBackendSession = {
    async run(operation) {
      return managed ? { managed: true, value: await operation(scope) } : { managed: false };
    },
  };
  return {
    service: createEnterpriseConsoleService(backend),
    paths,
    disableMenu: () => {
      enabled = false;
    },
    denyChannel: () => {
      channelAllowed = false;
    },
    denyApi: () => {
      apiAllowed = false;
    },
    unmanaged: () => {
      managed = false;
    },
    invalidate: () => {
      invalidateRead = true;
    },
    invalidateOperation: () => {
      invalidateOperation = true;
    },
    revokeChannelAfterRead: () => {
      revokeChannelAfterRead = true;
    },
    malformed: () => {
      agents = {
        items: [{ id: "agent", name: "Controlled", publishedVersion: 1, instructions: "private" }],
      };
    },
  };
}
test("legacy navigation IDs retain current menu admission while Agent APIs use independent channel policy", async () => {
  const f = fixture();
  assert.equal((await f.service.getNavigation()).status, "ready");
  assert.equal((await f.service.authorizeMenu("agents")).nameEn, "Automations");
  f.disableMenu();
  await assert.rejects(f.service.authorizeMenu("agents"), /enterprise_console_unavailable/);
  const count = f.paths.length;
  assert.deepEqual(await f.service.listAgents(), [
    { id: "agent", name: "Controlled", publishedVersion: 1 },
  ]);
  assert.deepEqual(f.paths.slice(count), [
    "/api/client/authorize",
    "/api/client/agents",
    "/api/client/authorize",
  ]);
  f.denyChannel();
  const denied = f.paths.length;
  await assert.rejects(f.service.listAgents(), /enterprise_console_unavailable/);
  assert.deepEqual(f.paths.slice(denied), ["/api/client/authorize"]);
});
test("accepted receipt survives navigation revocation, strips content and still permits stopping after channel closure", async () => {
  const f = fixture();
  const receipt = await f.service.createRun({ agentId: "agent", input: "controlled input" });
  assert.equal(receipt.id, "run");
  assert.equal("input" in receipt, false);
  assert.equal("output" in receipt, false);
  assert.equal((await f.service.readRun(receipt.id)).output, "caller-owned result");
  f.denyChannel();
  await assert.rejects(f.service.readRun(receipt.id), /enterprise_console_unavailable/);
  const count = f.paths.length;
  await f.service.cancelRun(receipt.id);
  assert.deepEqual(f.paths.slice(count), ["/api/client/runs/run/cancel"]);
});
test("independent backend permission failures reject every compatibility resource operation", async () => {
  const f = fixture();
  f.denyApi();
  for (const action of [
    () => f.service.listAgents(),
    () => f.service.listAssets(),
    () => f.service.listRuns(1),
    () => f.service.createRun({ agentId: "agent", input: "controlled input" }),
    () => f.service.readRun("run"),
    () => f.service.cancelRun("run"),
  ])
    await assert.rejects(action, /enterprise_console_unavailable/);
});
test("Agent channel revocation while HTTP results arrive suppresses the old catalog", async () => {
  const f = fixture();
  f.revokeChannelAfterRead();
  await assert.rejects(f.service.listAgents(), /enterprise_console_unavailable/);
  assert.deepEqual(f.paths, [
    "/api/client/authorize",
    "/api/client/agents",
    "/api/client/authorize",
  ]);
});
test("malformed catalogs and owner changes never reach consumers", async () => {
  const f = fixture();
  f.malformed();
  await assert.rejects(f.service.listAgents(), /enterprise_console_unavailable/);
  f.invalidate();
  assert.deepEqual(await f.service.getNavigation(), { status: "unavailable" });
  const late = fixture();
  late.invalidateOperation();
  await assert.rejects(late.service.listAgents(), /enterprise_console_unavailable/);
});
test("unmanaged mode has no backend operations or fabricated enterprise catalog", async () => {
  const f = fixture();
  f.unmanaged();
  assert.deepEqual(await f.service.getNavigation(), { status: "unmanaged" });
  await assert.rejects(f.service.listAgents(), /enterprise_console_unavailable/);
  assert.deepEqual(f.paths, []);
});
