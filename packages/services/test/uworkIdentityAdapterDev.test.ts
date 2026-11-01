import { test } from "node:test";
import assert from "node:assert/strict";
import { wecomIdentityConfigSchema } from "@zcode/shared";
import { createUWorkIdentityAdapter } from "../src/enterprise-identity/uworkIdentityAdapter.js";

const ORG = "org-1";
const config = (apiBaseUrl: string) =>
  wecomIdentityConfigSchema.parse({
    apiBaseUrl,
    backend: "uwork",
    callbackUrl: `${apiBaseUrl}/api/auth/wecom/callback`,
    organizations: [{ orgId: ORG, corpId: "ww-local-dev", agentId: "1000001" }],
    defaultOrgId: ORG,
  });

const attempt = (authorizeUrl: string, id = "attempt-1") => ({
  id,
  proof: "proof-1",
  authorizeUrl,
  expiresAt: Date.now() + 300_000,
});
const fetchReturning = (value: unknown) =>
  (async () => new Response(JSON.stringify(value), { status: 201 })) as unknown as typeof fetch;
const syntheticUrl = (base: string, id: string) => {
  const url = new URL("/api/auth/wecom/dev-synthetic", base);
  url.searchParams.set("state", id);
  url.searchParams.set("redirect_uri", `${base}/api/auth/wecom/callback`);
  return url.toString();
};

test("a loopback control plane may host its own synthetic authorization page", async () => {
  const base = "http://localhost:3210";
  const adapter = createUWorkIdentityAdapter(
    config(base),
    fetchReturning(attempt(syntheticUrl(base, "attempt-1"))),
  );
  const started = await adapter.start(new AbortController().signal, ORG);
  // 没有可拦截的原生回调：界面走外部浏览器 + 轮询，不挂起扫码视图。
  assert.equal(started.callbackUrl, undefined);
  assert.equal(new URL(started.authorizationUrl).origin, base);
});

test("the same page is rejected once the control plane is not loopback", async () => {
  const https = "https://auth.example.test";
  const adapter = createUWorkIdentityAdapter(
    config(https),
    fetchReturning(attempt(syntheticUrl(https, "attempt-2"), "attempt-2")),
  );
  await assert.rejects(
    adapter.start(new AbortController().signal, ORG),
    /Enterprise authorization binding mismatch/,
  );
});

test("the official WeCom authorization URL keeps the native callback flow", async () => {
  const base = "http://localhost:3210";
  const url = new URL("https://login.work.weixin.qq.com/wwlogin/sso/login");
  url.searchParams.set("state", "attempt-3");
  url.searchParams.set("redirect_uri", `${base}/api/auth/wecom/callback`);
  const adapter = createUWorkIdentityAdapter(
    config(base),
    fetchReturning(attempt(url.toString(), "attempt-3")),
  );
  const started = await adapter.start(new AbortController().signal, ORG);
  assert.equal(started.callbackUrl, `${base}/api/auth/wecom/callback`);
});
