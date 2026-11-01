import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import { createEnterpriseAssetsHost } from "../src/enterprise-assets/enterpriseAssetsHost.js";
import { createEnterpriseConnectorRelay } from "../src/enterprise-assets/connectorRelay.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";

const checksum = createHash("sha256")
  .update(JSON.stringify({ url: "https://controlled.example.test/mcp" }))
  .digest("hex");
const connector = {
  asset: { id: "controlled-connector", kind: "connector" as const, version: 1, checksum },
  name: "Controlled Connector",
  distributed: true,
};

async function fixture(t: TestContext, options: { allowed?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "uwork-connector-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new AbortController();
  const authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: owner.signal,
    session: {
      token: "synthetic-private",
      issuerOrigin: "https://backend.example.test",
      expiresAt: Date.now() + 60000,
      profile: { id: "member", tenantId: "tenant", provider: "wecom", displayName: "Controlled" },
    },
  };
  const calls: {
    admission: { target?: string; version?: number; checksum?: string };
    rpc: { path: string; body?: unknown; session?: string; method?: string };
  }[] = [];
  let allowed = options.allowed ?? true,
    rpcErrorCode = "CONNECTOR_DENIED",
    rpcStatus = 200,
    rpcBody: unknown = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "multiply" }] },
    },
    rpcSession: string | undefined = "backend-session-id";
  const backendSession = createUWorkBackendSession({
    resolveConfig: async () => ({ backend: "uwork", apiBaseUrl: "https://backend.example.test" }),
    readAuthority: () => authority,
    readPersistedSession: async () => ({
      revision: authority.revision,
      session: authority.session,
    }),
    fetchImpl: async (input, init) => {
      const request = new Request(String(input), init);
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-private");
      const path = new URL(request.url).pathname;
      if (path.endsWith("/assets"))
        return Response.json({
          items: [
            {
              id: connector.asset.id,
              kind: "connector",
              name: connector.name,
              version: connector.asset.version,
              checksum: connector.asset.checksum,
              distributed: true,
            },
          ],
        });
      if (path.endsWith("/download"))
        // 与真实后端一致：只回掩码描述与网关路径，不含远端地址或凭据。
        return Response.json({
          id: connector.asset.id,
          kind: "connector",
          version: connector.asset.version,
          content: { transport: "streamable-http", description: "受控连接器" },
          gatewayUrl: `/api/client/connectors/${connector.asset.id}/rpc`,
        });
      if (path === "/api/client/authorize") {
        const body = JSON.parse(String(await request.text())) as {
          action: string;
          target?: string;
          assetVersion?: number;
          assetChecksum?: string;
        };
        if (body.action === "execution")
          return Response.json({
            allowed: true,
            tenantId: "tenant",
            security: {
              allowShell: false,
              allowFilesystem: false,
              allowNetwork: false,
              dangerousSkills: false,
              allowedDomains: [],
            },
            personal: { skills: false },
          });
        calls.push({
          admission: {
            target: body.target,
            version: body.assetVersion,
            checksum: body.assetChecksum,
          },
          rpc: { path },
        });
        // 与真实后端一致：只有当前发布版本与校验和完全相符才允许。
        const current =
          body.target === connector.asset.id &&
          body.assetVersion === connector.asset.version &&
          body.assetChecksum === connector.asset.checksum;
        return Response.json({ allowed: allowed && current, tenantId: "tenant" });
      }
      const raw = await request.text();
      calls.push({
        admission: {},
        rpc: {
          path,
          method: request.method,
          ...(raw ? { body: JSON.parse(raw) } : {}),
          ...(request.headers.get("mcp-session-id")
            ? { session: request.headers.get("mcp-session-id")! }
            : {}),
        },
      });
      if (rpcStatus !== 200)
        return Response.json(
          rpcErrorCode
            ? { error: { code: rpcErrorCode, message: "denied" } }
            : { error: { message: "denied" } },
          { status: rpcStatus },
        );
      return Response.json(rpcBody, {
        status: 200,
        headers: rpcSession ? { "mcp-session-id": rpcSession } : {},
      });
    },
  });
  const assets = createEnterpriseAssetsHost({ backendSession, storageDirectory: directory });
  t.after(() => assets.disposeAllAndWait());
  const relay = createEnterpriseConnectorRelay({ backendSession, assets });
  const catalog = await assets.readCatalog(trace);
  assert.equal(catalog.status, "ready");
  const ownerKey = catalog.status === "ready" ? catalog.ownerKey : "";
  return {
    assets,
    ownerKey,
    calls,
    directory,
    relay,
    setAllowed: (value: boolean) => (allowed = value),
    setRpcError: (status: number, code = "CONNECTOR_DENIED") => {
      rpcStatus = status;
      rpcErrorCode = code;
    },
    setRpcSession: (session: string | undefined) => (rpcSession = session),
    setRpcBody: (body: unknown) => (rpcBody = body),
  };
}

const trace = "trace-controlled";

test("connector catalog stays metadata-only and is never materialized in the cache", async (t) => {
  const f = await fixture(t);
  const catalog = await f.assets.readCatalog(trace);
  assert.equal(catalog.status, "ready");
  if (catalog.status !== "ready") return;
  assert.deepEqual(catalog.connectors, [connector]);
  assert.deepEqual(catalog.assets, []);
  assert.deepEqual(catalog.experts, []);
  // 连接器没有目录/正文：目录项不能携带 key/directory，缓存里也不能留下任何对象。
  assert.equal("directory" in catalog.connectors[0]!, false);
  const profiles = await readdir(f.directory);
  assert.equal(profiles.length, 1);
  const entries = await readdir(join(f.directory, profiles[0]!));
  assert.equal(
    entries.filter((entry) => !entry.endsWith(".json") && !entry.endsWith(".lock")).length,
    0,
    "连接器目录读取不产生任何缓存对象",
  );
});

test("connector admission binds the published version and follows the backend decision", async (t) => {
  const f = await fixture(t);
  const admitted = await f.assets.authorizeAsset({ asset: connector.asset }, trace, undefined);
  assert.deepEqual(admitted, { allowed: true, code: "allowed" });
  const recorded = f.calls.find((entry) => entry.admission.target);
  assert.deepEqual(recorded?.admission, {
    target: connector.asset.id,
    version: connector.asset.version,
    checksum: connector.asset.checksum,
  });
  // 未发布的版本/校验和不会被旧绑定放行。
  assert.deepEqual(
    await f.assets.authorizeAsset({ asset: { ...connector.asset, version: 2 } }, trace, undefined),
    { allowed: false, code: "enterprise_asset_denied" },
  );
  f.setAllowed(false);
  assert.deepEqual(await f.assets.authorizeAsset({ asset: connector.asset }, trace), {
    allowed: false,
    code: "enterprise_asset_denied",
  });
});

test("connector relay forwards frames through the private backend session only", async (t) => {
  const f = await fixture(t);
  const frame = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const result = await f.relay.request({
    ownerKey: f.ownerKey,
    connector,
    frame,
    traceId: trace,
  });
  assert.deepEqual(result, {
    status: "ok",
    frame: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "multiply" }] } },
    mcpSessionId: "backend-session-id",
  });
  const forwarded = f.calls.find((entry) => entry.rpc.body);
  assert.equal(forwarded?.rpc.path, "/api/client/connectors/controlled-connector/rpc");
  assert.deepEqual(forwarded?.rpc.body, frame);
  // 后续帧必须带后端签发的会话标识。
  const second = await f.relay.request({
    ownerKey: f.ownerKey,
    connector,
    frame: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "multiply" } },
    mcpSessionId: "backend-session-id",
    traceId: trace,
  });
  assert.equal(second.status, "ok");
  assert.equal(f.calls.filter((entry) => entry.rpc.body).at(-1)?.rpc.session, "backend-session-id");
});

test("connector relay maps backend refusals to stable codes and never leaks the session", async (t) => {
  const f = await fixture(t);
  f.setRpcError(403);
  assert.deepEqual(
    await f.relay.request({
      ownerKey: f.ownerKey,
      connector,
      frame: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      traceId: trace,
    }),
    { status: "denied", code: "enterprise_connector_denied" },
  );
  f.setRpcError(409, "ASSET_VERSION_CHANGED");
  assert.deepEqual(
    await f.relay.request({
      ownerKey: f.ownerKey,
      connector,
      frame: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      traceId: trace,
    }),
    { status: "denied", code: "enterprise_asset_changed" },
  );
  // 没有稳定错误码时按状态码分类，不把服务端文本当分类依据。
  f.setRpcError(402, "");
  assert.deepEqual(
    await f.relay.request({
      ownerKey: f.ownerKey,
      connector,
      frame: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      traceId: trace,
    }),
    { status: "denied", code: "enterprise_subscription_inactive" },
  );
  // 准入撤销后连帧都不再外发。
  f.setRpcError(200);
  f.setAllowed(false);
  const before = f.calls.length;
  assert.deepEqual(
    await f.relay.request({
      ownerKey: f.ownerKey,
      connector,
      frame: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      traceId: trace,
    }),
    { status: "denied", code: "enterprise_asset_denied" },
  );
  assert.equal(f.calls.length, before + 1, "only the admission request left the Host");
});

test("connector release is an explicit DELETE bound to its session", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.relay.release({
      ownerKey: f.ownerKey,
      connector,
      mcpSessionId: "backend-session-id",
      traceId: trace,
    }),
    { status: "ok" },
  );
  const released = f.calls.filter((entry) => entry.rpc.method === "DELETE");
  assert.equal(released.length, 1);
  assert.equal(released[0]?.rpc.path, "/api/client/connectors/controlled-connector/rpc");
  assert.equal(released[0]?.rpc.session, "backend-session-id");
});

test("a managed profile cannot relay connectors without its own session binding", async (t) => {
  const f = await fixture(t);
  // ownerKey 与当前私有会话不一致（例如换账号后的旧目录）必须拒绝。
  assert.deepEqual(
    await f.relay.request({
      ownerKey: "b".repeat(64),
      connector,
      frame: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      traceId: trace,
    }),
    { status: "denied", code: "enterprise_identity_changed" },
  );
});
