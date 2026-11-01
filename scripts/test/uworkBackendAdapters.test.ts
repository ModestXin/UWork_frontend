import test from "node:test";
import assert from "node:assert/strict";
import { wecomIdentityConfigSchema } from "../../packages/shared/src/index.js";
import { createUWorkIdentityAdapter } from "../../packages/services/src/enterprise-identity/uworkIdentityAdapter.js";
import { createUWorkGatewayClient } from "../../packages/services/src/ucas-gateway/uworkGatewayClient.js";
import { formatCost } from "../../packages/ui/src/settings/ucas-gateway/gatewayFormat.js";

test("explicit self-owned backend accepts opaque sessions and scoped credentials without reveal", async () => {
  const config = {
    backend: "uwork",
    apiBaseUrl: "https://issuer.example.test",
    callbackUrl: "https://issuer.example.test/api/auth/wecom/callback",
    organizations: [{ orgId: "org", corpId: "ww-test", agentId: "1" }],
  };
  const { backend, ...legacy } = config;
  assert.equal(backend, "uwork");
  assert.equal(wecomIdentityConfigSchema.parse(legacy).backend, "ucas");
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    let result: unknown;
    if (url.pathname === "/api/auth/wecom/attempts") {
      const auth = new URL("https://login.work.weixin.qq.com/wwlogin/sso/login");
      auth.search = new URLSearchParams({
        state: "attempt",
        redirect_uri: config.callbackUrl,
        appid: "ww-test",
        agentid: "1",
        login_type: "CorpApp",
      }).toString();
      result = {
        id: "attempt",
        proof: "synthetic-proof",
        authorizeUrl: auth.href,
        expiresAt: Date.now() + 300000,
      };
    } else if (url.pathname.endsWith("/claim"))
      result = { status: "authorized", token: "opaque-session" };
    else if (url.pathname === "/api/auth/me")
      result = {
        user: { id: "user", name: "Fixture", email: null },
        tenant: { id: "org" },
        role: "owner",
        expiresAt: Date.now() + 3600000,
      };
    else if (url.pathname === "/api/auth/device-tokens")
      result = { id: "device", token: "scoped-device", expiresAt: Date.now() + 3600000 };
    else if (url.pathname === "/v1/models") result = { data: [{ id: "local-model" }] };
    else result = { ok: true };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const identity = createUWorkIdentityAdapter(config, request);
  const signal = new AbortController().signal;
  const attempt = await identity.start(signal, "org");
  const session = await identity.complete!("code", signal, "org");
  assert.equal(session.token, "opaque-session");
  assert.equal(session.profile.tenantId, "org");
  const gateway = createUWorkGatewayClient({
    apiBaseUrl: config.apiBaseUrl,
    token: session.token,
    fetchImpl: request,
  });
  assert.equal((await gateway.issueDeviceCredential!("old-device")).apiKey, "scoped-device");
  assert.deepEqual((await gateway.readPlanModels()).models, ["local-model"]);
  assert.equal((await gateway.readProfile()).role, "super_admin");
  assert.equal(
    calls.some((p) => p.includes("reveal")),
    false,
  );
  assert.ok(formatCost("en-US", 1000, "credits").includes("Credit"));
  assert.ok(!formatCost("en-US", 1000, "credits").includes("$"));
  await identity.start(signal, "org");
  await identity.cancel!(attempt.id);
  assert.ok(calls.includes("POST /api/auth/wecom/attempts/attempt/cancel"));
});
