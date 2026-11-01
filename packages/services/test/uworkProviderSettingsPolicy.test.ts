import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHostApiNetworkTransport } from "../src/providers/api/nodeApiNetwork.js";
import { discoverPolicyAwareProviderModels } from "../src/model-provider/uworkProviderSettingsPolicy.js";
import { providerSettingsTrustedGatewayProvisioning } from "../src/model-provider/providerFacadeServices.js";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { createUWorkProviderSettingsPolicy } from "../src/model-provider/uworkProviderSettingsPolicy.js";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";

const config = {
  api: { type: "openai-chat-completions" as const, baseUrl: "https://models.example.test/v1" },
  access: { type: "api-key" as const, apiKey: "controlled-personal-key" },
};
async function fixture(t: TestContext) {
  let models = true,
    managed = true,
    malformed = false,
    discoveries = 0;
  const controller = new AbortController();
  let authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: controller.signal,
    session: {
      token: "controlled-private-backend",
      issuerOrigin: "https://backend.example.test",
      expiresAt: Date.now() + 60000,
      profile: { id: "member", tenantId: "tenant", displayName: "Controlled", provider: "wecom" },
    },
  };
  let onDiscover: (() => void) | undefined;
  const backend = createUWorkBackendSession({
    resolveConfig: async () => ({
      backend: managed ? ("uwork" as const) : ("ucas" as const),
      apiBaseUrl: "https://backend.example.test",
    }),
    readAuthority: () => authority,
    readPersistedSession: async () => ({
      revision: authority.revision,
      session: authority.session,
    }),
    fetchImpl: async (_input, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer controlled-private-backend",
      );
      assert.deepEqual(JSON.parse(String(init?.body)), { action: "execution", channel: "local" });
      return Response.json({
        tenantId: "tenant",
        allowed: true,
        security: {
          allowShell: false,
          allowFilesystem: true,
          allowNetwork: true,
          dangerousSkills: false,
          allowedDomains: [],
        },
        ...(malformed ? {} : { personal: { models, skills: false, connectors: false } }),
      });
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "uwork-provider-policy-"));
  const policy = createUWorkProviderSettingsPolicy(() => backend);
  const runtime = createProviderRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(dir, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
    settingsPolicy: policy,
    discoverModels: async () => {
      discoveries++;
      onDiscover?.();
      return ["discovered"];
    },
  });
  t.after(async () => {
    runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  await runtime.start();
  const created = await runtime.providerSettings.createPersonalProvider({
    providerName: "Controlled enterprise-looking provider",
    initialConfig: config,
  });
  await runtime.providerSettings.addPersonalModel(created.providerId, "existing", {});
  return {
    runtime,
    policy,
    service: runtime.providerSettings,
    id: created.providerId,
    file: join(dir, "personal.json"),
    models: (value: boolean) => {
      models = value;
    },
    ucas: () => {
      managed = false;
    },
    malformed: () => {
      malformed = true;
    },
    discoverCount: () => discoveries,
    onDiscover: (fn: () => void) => {
      onDiscover = fn;
    },
    logout: () => {
      controller.abort();
      authority = { ...authority, generation: 2, session: null };
    },
  };
}

for (const operation of [
  "create",
  "overlay",
  "add",
  "draft",
  "discover",
  "resolve",
  "provision",
  "apikey",
  "delete",
  "rename",
  "toggle",
  "reorder",
] as const)
  test(`personal.models=false rejects ProviderSettings ${operation} without changing existing configuration`, async (t) => {
    const f = await fixture(t);
    const view = await f.service.getView();
    const before = await readFile(f.file, "utf8");
    f.models(false);
    const work = () => {
      switch (operation) {
        case "create":
          return f.service.createPersonalProvider({
            providerName: "Another",
            initialConfig: config,
          });
        case "overlay":
          return f.service.savePersonalProviderOverlay(f.id, config);
        case "add":
          return f.service.addPersonalModel(f.id, "new", {});
        case "draft":
          return f.service.savePersonalModelDraft({
            providerId: f.id,
            originalModelId: "existing",
            nextModelId: "existing",
            personalConfig: {},
            basedOnRevision: view.revision,
          });
        case "discover":
          return f.service.discoverModels(f.id);
        case "resolve":
          return f.service.resolveModelConfig({ providerId: f.id, modelId: "existing" });
        case "provision":
          return f.service.applyUcasGatewayProvisioning({
            baseUrl: "https://attacker.example.test/v1",
            apiKey: "forged",
            modelIds: ["forged"],
          });
        case "apikey":
          return f.service.setUcasApiKeyIfMissing("forged");
        case "delete":
          return f.service.deletePersonalProvider(f.id);
        case "rename":
          return f.service.renamePersonalModel(f.id, "existing", "new");
        case "toggle":
          return f.service.setPersonalModelEnabled(f.id, "existing", false);
        case "reorder":
          return f.service.reorderPersonalModels(f.id, ["existing"]);
      }
    };
    await assert.rejects(work, { code: "enterprise_personal_models_denied" });
    assert.equal(await readFile(f.file, "utf8"), before);
    assert.equal(f.discoverCount(), 0);
  });

test("model discovery revocation after remote results prevents importing any model IDs", async (t) => {
  const f = await fixture(t);
  f.onDiscover(() => f.models(false));
  await assert.rejects(() => f.service.discoverModels(f.id), {
    code: "enterprise_personal_models_denied",
  });
  assert.equal(f.discoverCount(), 1);
  assert.ok(
    !(await f.service.getView()).providers
      .find((item) => item.providerId === f.id)!
      .models.some((item) => item.modelId === "discovered"),
  );
});

test("explicit unmanaged UCAS retains personal settings behavior", async (t) => {
  const f = await fixture(t);
  f.models(false);
  f.ucas();
  const created = await f.service.createPersonalProvider({
    providerName: "Unmanaged",
    initialConfig: config,
  });
  assert.ok(created.providerId);
  assert.equal((await f.service.discoverModels(f.id)).added, 1);
});

test("managed Gateway resolution uses the actual current issuer URL, not a public provider ID", async (t) => {
  const f = await fixture(t);
  await f.service.applyUcasGatewayProvisioning({
    baseUrl: "https://backend.example.test/v1",
    modelIds: ["managed"],
  });
  f.models(false);
  assert.ok(await f.service.resolveModelConfig({ providerId: "ucas", modelId: "managed" }));
  f.models(true);
  await f.service.applyUcasGatewayProvisioning({
    baseUrl: "https://external.example.test/v1",
    modelIds: ["managed"],
  });
  f.models(false);
  await assert.rejects(
    () => f.service.resolveModelConfig({ providerId: "ucas", modelId: "managed" }),
    { code: "enterprise_personal_models_denied" },
  );
});

test("the private Symbol Gateway port keeps the existing writer without exposing a public policy exemption", async (t) => {
  const f = await fixture(t);
  f.models(false);
  const result = await f.service[providerSettingsTrustedGatewayProvisioning]({
    baseUrl: "https://backend.example.test/v1",
    apiKey: "managed-private-key",
    modelIds: ["managed"],
  });
  assert.equal(result.hasApiKey, true);
  assert.ok(
    (await f.service.getView()).providers
      .find((item) => item.providerId === "ucas")!
      .models.some((item) => item.modelId === "managed"),
  );
  assert.ok(!Object.keys(f.service).includes(String(providerSettingsTrustedGatewayProvisioning)));
  await assert.rejects(
    () => f.service.applyUcasGatewayProvisioning({ baseUrl: "https://external.example.test/v1" }),
    { code: "enterprise_personal_models_denied" },
  );
});

test("missing personal policy fails closed even for an existing configuration", async (t) => {
  const f = await fixture(t);
  f.malformed();
  await assert.rejects(
    () => f.service.resolveModelConfig({ providerId: f.id, modelId: "existing" }),
    { code: "enterprise_policy_unavailable" },
  );
});

test("logout while model discovery is running cannot import late IDs", async (t) => {
  const f = await fixture(t);
  f.onDiscover(f.logout);
  await assert.rejects(() => f.service.discoverModels(f.id));
  assert.ok(
    !(await f.service.getView()).providers
      .find((item) => item.providerId === f.id)!
      .models.some((item) => item.modelId === "discovered"),
  );
});

test("personal discovery uses the real Host transport guard after asynchronous proxy preparation", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end(JSON.stringify({ data: [{ id: "unexpected" }] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const transport = createHostApiNetworkTransport(async () => {
    f.models(false);
    return {};
  });
  t.after(() => transport.disposeAndWait());
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  await assert.rejects(
    () =>
      f.policy.run((scope) =>
        discoverPolicyAwareProviderModels(
          { ...config, api: { ...config.api, baseUrl } },
          transport.fetch,
          scope,
        ),
      ),
    { code: "enterprise_personal_models_denied" },
  );
  assert.equal(requests, 0, "no personal API key or discovery request can leave after revocation");
});

test("per-page discovery guards preserve supported same-origin cursor queries and personal credentials", async (t) => {
  const f = await fixture(t);
  const paths: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer controlled-personal-key");
    paths.push(req.url!);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        paths.length === 1
          ? { data: [{ id: "first" }], has_more: true, last_id: "cursor" }
          : { data: [{ id: "second" }], has_more: false },
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const transport = createHostApiNetworkTransport(async () => ({}));
  t.after(() => transport.disposeAndWait());
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const result = await f.policy.run((scope) =>
    discoverPolicyAwareProviderModels(
      { ...config, api: { ...config.api, baseUrl } },
      transport.fetch,
      scope,
    ),
  );
  assert.deepEqual(result, ["first", "second"]);
  assert.deepEqual(paths, ["/v1/models", "/v1/models?after_id=cursor"]);
});

test("only the private Gateway Symbol may establish enterprise-session access", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () =>
      f.service.createPersonalProvider({
        providerName: "forged catalog",
        initialConfig: { enterpriseModelIds: ["forged"] },
      }),
    /enterprise_session_private_only/,
  );
  await assert.rejects(
    () => f.service.savePersonalProviderOverlay(f.id, { enterpriseModelIds: [] }),
    /enterprise_session_private_only/,
  );
  await assert.rejects(
    () =>
      f.service[providerSettingsTrustedGatewayProvisioning]({
        baseUrl: "https://backend.example.test/v1",
        authMode: "enterprise-session",
        modelIds: [],
        isCurrent: () => false,
      }),
    /enterprise_identity_changed/,
  );

  await assert.rejects(
    () =>
      f.service.createPersonalProvider({
        providerName: "forged managed",
        initialConfig: { access: { type: "enterprise-session" } },
      }),
    /enterprise_session_private_only/,
  );
  await assert.rejects(
    () => f.service.savePersonalProviderOverlay(f.id, { access: { type: "enterprise-session" } }),
    /enterprise_session_private_only/,
  );
  const applied = await f.service[providerSettingsTrustedGatewayProvisioning]({
    baseUrl: "https://backend.example.test/v1",
    authMode: "enterprise-session",
    modelIds: [],
    managedModels: [],
  });
  const managed = applied.view.providers.find((provider) => provider.providerId === "ucas");
  assert.equal(managed?.effectiveConfig.access?.type, "enterprise-session");
  assert.equal(applied.hasApiKey, false);
  assert.ok(!(await readFile(f.file, "utf8")).includes("controlled-private-backend"));
});
