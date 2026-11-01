import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
/**
 * 这个用例要同时驱动自有后台（uwork_backend）的真实 Fastify 实例，属于跨仓联测。
 * 客户端仓库里没有后台源码，因此只有设置 UWORK_BACKEND_ROOT 时才运行，否则跳过。
 */
async function loadBackend() {
  const root = process.env.UWORK_BACKEND_ROOT;
  if (!root) return undefined;
  const base = pathToFileURL(join(root, sep)).href;
  const app = (await import(new URL("src/app.ts", base).href)) as {
    createApp: (options: unknown) => Promise<never>;
  };
  const identity = (await import(new URL("src/identity.ts", base).href)) as {
    bootstrap: (database: unknown, input: unknown) => Promise<never>;
  };
  return { bootstrap: identity.bootstrap, createApp: app.createApp };
}

import { withFileLock } from "@zcode/shared/node";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { providerSettingsTrustedGatewayProvisioning } from "../src/model-provider/providerFacadeServices.js";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import { createEnterpriseModelRelay } from "../src/enterprise-model-relay/relay.js";

type Row = Record<string, unknown>;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "uwork-catalog-independent-"));
  const path = join(directory, "personal.json");
  const runtime = createProviderRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: path,
    personalPollingIntervalMs: false,
    watch: false,
  });
  t.after(async () => {
    runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.start();
  const apply = (
    ids: readonly string[],
    isCurrent?: () => boolean,
    baseUrl = "https://backend.example.test/v1",
  ) =>
    runtime.providerSettings[providerSettingsTrustedGatewayProvisioning]({
      baseUrl,
      authMode: "enterprise-session",
      modelIds: ids,
      managedModels: ids.map((id) => ({
        id,
        contextWindow: 128000,
        maxOutputTokens: 16,
        supportsVision: false,
        supportsReasoning: false,
        supportsTools: false,
      })),
      ...(isCurrent ? { isCurrent } : {}),
    });
  const raw = () => readFile(path, "utf8");
  const candidates = () =>
    runtime.registryService.getProvider("ucas")?.models.map((model) => model.modelId) ?? [];
  const replaceSnapshot = async (value: unknown, omit = false) => {
    const document = JSON.parse(await raw());
    const encoded = JSON.stringify(
      document,
      (key, current) => (key === "enterpriseModelIds" ? (omit ? undefined : value) : current),
      2,
    );
    await writeFile(path, encoded, { mode: 0o600 });
    await runtime.registryService.refresh("independent-personal-file-edit");
  };
  return { runtime, apply, raw, path, directory, candidates, replaceSnapshot };
}

test("independent catalog: public writers cannot claim the reserved managed snapshot", async (t) => {
  const f = await fixture(t);
  await f.apply(["allowed-opaque"]);
  const original = await f.raw();
  for (const value of [[], ["forged"], null]) {
    await assert.rejects(
      f.runtime.providerSettings.createPersonalProvider({
        initialConfig: { enterpriseModelIds: value },
      } as never),
      /enterprise_session_private_only/,
    );
    await assert.rejects(
      f.runtime.providerSettings.savePersonalProviderOverlay("ucas", {
        enterpriseModelIds: value,
      } as never),
      /enterprise_session_private_only/,
    );
  }
  assert.equal(
    await f.raw(),
    original,
    "rejected public payloads leave the complete real file unchanged",
  );
  assert.deepEqual(f.candidates(), ["allowed-opaque"]);
  await f.runtime.providerSettings.applyUcasGatewayProvisioning({
    baseUrl: "https://backend.example.test/v1",
    modelIds: ["forged-public-append"],
    authMode: "enterprise-session",
    enterpriseModelIds: ["forged-public-append"],
  } as never);
  assert.deepEqual(
    f.candidates(),
    ["allowed-opaque"],
    "public compatibility writer cannot forward private mode or candidate claims",
  );
});

test("independent catalog: missing null and empty snapshots never fall back to stored legacy candidates", async (t) => {
  const f = await fixture(t);
  for (const value of [undefined, null, []]) {
    await f.apply(["allowed-opaque"]);
    await f.replaceSnapshot(value, value === undefined);
    assert.deepEqual(f.candidates(), []);
    assert.equal((await f.runtime.modelSelection.getView()).preferredSelection, undefined);
    assert.ok(
      (await f.raw()).includes("ucas-deepseek-flash"),
      "legacy membership is retained in storage rather than deleted",
    );
  }
});

test("independent catalog: a stale clear queued behind the actual repository lock cannot commit", async (t) => {
  const f = await fixture(t);
  await f.apply(["new-owner-catalog"]);
  const before = await f.raw();
  let release!: () => void, entered!: () => void, checked!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const acquired = new Promise<void>((done) => {
    entered = done;
  });
  const prechecked = new Promise<void>((done) => {
    checked = done;
  });
  const lock = withFileLock(f.path, async () => {
    entered();
    await held;
  });
  await acquired;
  let current = true,
    checks = 0;
  const oldClear = f.apply([], () => {
    if (++checks === 2) checked();
    return current;
  });
  const rejected = assert.rejects(oldClear, /enterprise_identity_changed/);
  try {
    await prechecked;
    current = false;
  } finally {
    release();
  }
  await lock;
  await rejected;
  assert.ok(
    checks >= 3,
    "scope was checked again in the locked mutation rather than only before queueing",
  );
  assert.equal(await f.raw(), before);
  assert.deepEqual(f.candidates(), ["new-owner-catalog"]);
});

test("independent catalog: a forged disk candidate cannot replace private-session backend authorization", async (t) => {
  const backend = await loadBackend();
  if (!backend) {
    t.skip("需要 UWORK_BACKEND_ROOT 指向 uwork_backend 仓库根目录");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "uwork-catalog-backend-"));
  let providerCalls = 0;
  const provider = createServer((req, res) => {
    req.resume();
    providerCalls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "authorized-result" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const app = await backend.createApp({
    database: join(directory, "backend.sqlite"),
    masterKey: randomBytes(32),
    publicUrl: "http://localhost:3000",
    allowPrivateUpstreams: true,
  });
  let relay: ReturnType<typeof createEnterpriseModelRelay> | undefined;
  t.after(async () => {
    relay?.dispose();
    try {
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
    } finally {
      try {
        app.server.closeAllConnections();
        await app.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  const password = "Synthetic-catalog-password!";
  const owner = await backend.bootstrap(app.services.db, {
    name: "Catalog authorization",
    email: "catalog-owner@example.test",
    password,
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  async function api(method: string, path: string, token = "", body?: unknown, expected = 200) {
    const response = await fetch(origin + path, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        connection: "close",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, expected, "controlled backend setup or authorization result");
    return (await response.json()) as Row;
  }
  const ownerToken = String(
    (
      await api("POST", "/api/auth/login", "", {
        email: "catalog-owner@example.test",
        password,
      })
    ).token,
  );
  const prefix = `/api/tenants/${owner.tenantId}`;
  const alice = await api(
    "POST",
    `${prefix}/members`,
    ownerToken,
    {
      name: "Alice",
      email: "catalog-alice@example.test",
      password,
      role: "member",
      seat: true,
    },
    201,
  );
  const bob = await api(
    "POST",
    `${prefix}/members`,
    ownerToken,
    {
      name: "Bob",
      email: "catalog-bob@example.test",
      password,
      role: "member",
      seat: true,
    },
    201,
  );
  const aliceToken = String(
    (
      await api("POST", "/api/auth/login", "", {
        email: "catalog-alice@example.test",
        password,
      })
    ).token,
  );
  const credential = await api(
    "POST",
    `${prefix}/credentials`,
    ownerToken,
    { name: "Controlled supplier", value: randomBytes(32).toString("hex") },
    201,
  );
  const modelInput = {
    name: "Controlled",
    upstreamModel: "controlled",
    baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    credentialId: credential.id,
    scope: { all: true },
  };
  const allowed = await api("POST", `${prefix}/models`, ownerToken, modelInput, 201);
  const denied = await api("POST", `${prefix}/models`, ownerToken, modelInput, 201);
  const f = await fixture(t);
  await f.apply([String(allowed.id), String(denied.id)], undefined, `${origin}/v1`);
  await api("PUT", `${prefix}/models/${denied.id}`, ownerToken, {
    ...modelInput,
    scope: { members: [bob.id] },
    revision: 1,
  });
  const actual = await api("GET", "/v1/models", aliceToken);
  assert.deepEqual(
    (actual.data as Row[]).map((model) => model.id),
    [allowed.id],
  );
  await f.apply([String(allowed.id)], undefined, `${origin}/v1`);
  const controller = new AbortController();
  const session = {
    token: aliceToken,
    issuerOrigin: origin,
    expiresAt: Date.now() + 60000,
    profile: {
      id: String(alice.id),
      tenantId: owner.tenantId,
      provider: "wecom" as const,
      displayName: "Synthetic Alice",
    },
  };
  const backendSession = createUWorkBackendSession({
    resolveConfig: async () => ({ backend: "uwork", apiBaseUrl: origin }),
    readAuthority: () => ({
      generation: 1,
      revision: 1,
      session,
      signal: controller.signal,
    }),
    readPersistedSession: async () => ({ revision: 1, session }),
  });
  const proof = await backendSession.run(async (scope) => scope.ownerKey);
  assert.ok(proof.managed);
  const ownerKey = proof.value;
  relay = createEnterpriseModelRelay({ backendSession });
  const binding = {
    runtime: {},
    workspaceKey: "owned-workspace",
    sessionId: "owned-conversation",
  };
  const request = async (modelId: unknown) => {
    const opened = await relay!.request({
      ...binding,
      request: {
        kind: "open",
        ownerKey,
        url: `${origin}/v1/chat/completions`,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "Controlled" }],
          max_tokens: 16,
        }),
      },
    });
    assert.ok(opened.status === "ok" && opened.streamId);
    const chunks: Buffer[] = [];
    for (let i = 0; i < 32; i++) {
      const next = await relay!.request({
        ...binding,
        request: { kind: "read", streamId: opened.streamId },
      });
      assert.equal(next.status, "ok");
      if (next.status !== "ok") break;
      if (next.chunk) chunks.push(Buffer.from(next.chunk, "base64"));
      if (next.done) break;
    }
    const text = Buffer.concat(chunks).toString();
    assert.equal(
      text.includes(aliceToken),
      false,
      "private identity never reaches caller protocol bytes",
    );
    return { status: opened.httpStatus, value: JSON.parse(text) as Row };
  };
  assert.equal((await request(allowed.id)).status, 200);
  assert.equal(providerCalls, 1);
  // Explicit untrusted-disk edit is restricted to this owned fixture file.
  await f.replaceSnapshot([denied.id]);
  assert.deepEqual(f.candidates(), [denied.id]);
  assert.equal(
    f.runtime.registryService.validateSelection({
      providerId: "ucas",
      modelId: String(denied.id),
      options: { reasoningLevel: "none" },
    }).ok,
    true,
  );
  const forbidden = await request(denied.id);
  assert.equal(forbidden.status, 403);
  assert.equal((forbidden.value.error as Row).code, "MODEL_DENIED");
  assert.equal(providerCalls, 1);
  assert.equal(
    app.services.db.get<{ count: number }>("SELECT count(*) AS count FROM ledger")!.count,
    1,
  );
});
