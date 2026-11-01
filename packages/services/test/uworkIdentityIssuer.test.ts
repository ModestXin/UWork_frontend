import assert from "node:assert/strict";
import { test } from "node:test";
import { createUWorkIdentityAdapter } from "../src/enterprise-identity/uworkIdentityAdapter.js";
import { createUcasGatewayService } from "../src/ucas-gateway/ucasGatewayService.js";

const session = {
  token: "synthetic-only",
  expiresAt: Date.now() + 60000,
  profile: {
    id: "member",
    tenantId: "tenant",
    provider: "wecom" as const,
    displayName: "Controlled",
  },
};
const config = {
  backend: "uwork",
  apiBaseUrl: "https://new.example.test",
  callbackUrl: "https://new.example.test/callback",
  organizations: [{ orgId: "tenant", corpId: "ww-controlled", agentId: "1" }],
};

test("a stored UWork session is not sent to a different or unknown issuer origin", async () => {
  let requests = 0;
  const adapter = createUWorkIdentityAdapter(config, async () => {
    requests++;
    throw new Error("must not send");
  });
  for (const previous of [session, { ...session, issuerOrigin: "https://old.example.test" }]) {
    assert.equal(await adapter.restore(previous, new AbortController().signal), null);
    await adapter.revoke?.(previous);
  }
  assert.equal(requests, 0);
});

test("a current-issuer session restores without losing its private origin binding", async () => {
  const adapter = createUWorkIdentityAdapter(config, async (input, init) => {
    assert.equal(new URL(String(input)).origin, config.apiBaseUrl);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-only");
    return Response.json({
      user: { id: "member", name: "Controlled" },
      tenant: { id: "tenant" },
      expiresAt: session.expiresAt,
    });
  });
  const restored = await adapter.restore(
    { ...session, issuerOrigin: config.apiBaseUrl },
    new AbortController().signal,
  );
  assert.equal(restored?.issuerOrigin, config.apiBaseUrl);
});

test("the UWork gateway cannot repoint an existing private session to a new backend issuer", async () => {
  let requests = 0,
    writes = 0;
  const service = createUcasGatewayService({
    store: { read: async () => null, write: async () => {} },
    readIdentitySession: async () => ({ ...session, issuerOrigin: "https://old.example.test" }),
    resolveApiBaseUrl: async () => config.apiBaseUrl,
    resolveBackend: async () => "uwork",
    provisioning: {
      apply: async () => {
        writes++;
        return { apiKeyApplied: false, hasApiKey: false, modelsAdded: 0, modelsSkipped: 0 };
      },
      listModels: async () => [],
    },
    fetchImpl: async () => {
      requests++;
      throw new Error("must not send an old session");
    },
  });
  try {
    await service.sync("controlled-issuer-change");
  } finally {
    service.disposeAll();
  }
  assert.equal(requests, 0);
  assert.equal(writes, 0);
});
