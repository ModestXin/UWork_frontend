import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import { createClientPresentationReader } from "../src/enterprise-identity/clientPresentation.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";

test("published presentation uses real HTTP, tracks publication and rejects stale owners", async () => {
  let welcome = "企业欢迎",
    version = 0;
  let responseBody: unknown;
  let afterRequest: (() => void) | undefined;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        responseBody ?? {
          tenantId: "tenant",
          versions: { "new-chat": version },
          configuration: {
            "new-chat": { welcome, riskNotice: "请核实" },
            personal: { mcpHub: "private" },
          },
          riskPrefix: "内容由 AI 生成",
        },
      ),
    );
    afterRequest?.();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  let backend: "uwork" | "ucas" = "uwork";
  const controller = new AbortController();
  let authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: controller.signal,
    session: {
      token: "synthetic-test",
      issuerOrigin: origin,
      expiresAt: Date.now() + 60000,
      profile: { id: "member", tenantId: "tenant", provider: "wecom", displayName: "Controlled" },
    },
  };
  const backendSession = createUWorkBackendSession({
    resolveConfig: async () => ({ backend, apiBaseUrl: origin }),
    readAuthority: () => authority,
    readPersistedSession: async () => ({
      revision: authority.revision,
      session: authority.session,
    }),
  });
  const read = createClientPresentationReader(backendSession);
  try {
    assert.deepEqual(await read(), {
      status: "ready",
      version: 0,
      welcome: "企业欢迎",
      riskNotice: "请核实",
      riskPrefix: "内容由 AI 生成",
      scenes: { status: "unsupported" },
      help: { status: "unsupported" },
      desktop: { status: "unsupported" },
      pluginStore: { status: "unsupported" },
    });
    welcome = "";
    version = 2;
    assert.equal((await read()).status, "ready");
    assert.deepEqual(await read(), {
      status: "ready",
      version: 2,
      welcome: "",
      riskNotice: "请核实",
      riskPrefix: "内容由 AI 生成",
      scenes: { status: "unsupported" },
      help: { status: "unsupported" },
      desktop: { status: "unsupported" },
      pluginStore: { status: "unsupported" },
    });
    responseBody = { tenantId: "other" };
    assert.deepEqual(await read(), { status: "unavailable" });
    responseBody = undefined;
    afterRequest = () => {
      authority = { ...authority, generation: 2, session: null };
    };
    assert.deepEqual(await read(), { status: "unavailable" });
    assert(requests.every((path) => path === "/api/client/configuration"));
    backend = "ucas";
    const count = requests.length;
    assert.deepEqual(await read(), { status: "unmanaged" });
    assert.equal(requests.length, count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
