import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRootTraceContext,
  createSessionId,
  type EnterpriseConnectorPort,
  type EnterpriseToolAuthorizationRequest,
  type McpCallToolRequest,
  type McpPort,
  type McpServerConfig,
} from "@zcode/contracts";
import type { EnterpriseSkillsCatalog } from "@zcode/shared";
import { withEnterpriseConnectorServers } from "../../adapters/src/mcp/enterprise-connectors.js";

const ownerKey = "a".repeat(64);
const traceContext = createRootTraceContext({ sessionId: createSessionId("parent") });
const connector = {
  asset: {
    id: "controlled-connector",
    kind: "connector" as const,
    version: 1,
    checksum: "b".repeat(64),
  },
  name: "Controlled Connector",
  distributed: true,
};

function catalog(connectors = [connector]): EnterpriseSkillsCatalog {
  return {
    status: "ready",
    ownerKey,
    allowFilesystem: false,
    personalSkills: false,
    dangerousSkills: false,
    assets: [],
    experts: [],
    connectors,
  };
}

/** 受控连接器端口：代替 Host 反向 RPC，逐帧应答并记录。 */
function connectorPort(options: { allow?: () => boolean } = {}) {
  const frames: Record<string, unknown>[] = [];
  const releases: string[] = [];
  let sessions = 0;
  const port: EnterpriseConnectorPort = {
    async request(input) {
      if (options.allow && !options.allow())
        return { status: "denied", code: "enterprise_asset_denied" };
      const frame = input.frame as { id?: number; method: string; params?: unknown };
      frames.push({ ...frame, ...(input.mcpSessionId ? { session: input.mcpSessionId } : {}) });
      if (frame.method === "initialize") {
        const session = `session-${++sessions}`;
        return {
          status: "ok",
          mcpSessionId: session,
          frame: {
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "controlled", version: "1" },
            },
          },
        };
      }
      if (frame.method === "notifications/initialized") return { status: "ok" };
      if (frame.method === "tools/list")
        return {
          status: "ok",
          frame: {
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              tools: [
                {
                  name: "multiply",
                  description: "Multiply integers",
                  inputSchema: {
                    type: "object",
                    properties: { left: { type: "number" }, right: { type: "number" } },
                  },
                },
              ],
            },
          },
        };
      if (frame.method === "tools/call")
        return {
          status: "ok",
          frame: {
            jsonrpc: "2.0",
            id: frame.id,
            result: { content: [{ type: "text", text: "42" }] },
          },
        };
      return {
        status: "ok",
        frame: {
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32601, message: "unknown method" },
        },
      };
    },
    async release(input) {
      releases.push(input.mcpSessionId);
      return { status: "ok" };
    },
  };
  return { frames, port, releases, sessions: () => sessions };
}

/** 既有 MCP 所有者：连接器装饰器必须与它共存，未识别请求原样下沉。 */
function innerPort() {
  const calls: McpCallToolRequest[] = [];
  const connected: Record<string, McpServerConfig>[] = [];
  const port: McpPort = {
    async connectConfiguredServers(servers) {
      connected.push(servers);
      return { statuses: {}, tools: [] };
    },
    async connectServer() {
      return {
        status: "disconnected",
        transport: "stdio",
        toolCount: 0,
        updatedAt: new Date().toISOString(),
      };
    },
    async disconnectServer() {
      return undefined;
    },
    async status() {
      return {};
    },
    async listTools() {
      return [];
    },
    async callTool(request) {
      calls.push(request);
      throw new Error(`inner call unexpected: ${request.serverName}`);
    },
    async close() {
      /* 受控内部端口无资源。 */
    },
  };
  return { calls, connected, port };
}

function owner(
  options: {
    authorization?: (request: EnterpriseToolAuthorizationRequest) => {
      allowed: boolean;
      code: string;
    };
    catalog?: () => EnterpriseSkillsCatalog;
  } = {},
) {
  const inner = innerPort();
  const connectors = connectorPort(
    options.authorization
      ? {
          allow: () => true,
        }
      : {},
  );
  const admissions: EnterpriseToolAuthorizationRequest[] = [];
  const authorization = {
    async authorize(request: EnterpriseToolAuthorizationRequest) {
      admissions.push(structuredClone(request));
      if (request.asset && request.asset.asset.kind === "connector" && options.authorization)
        return options.authorization(request);
      return { allowed: true, code: "allowed" };
    },
  };
  const catalogPort = {
    async readCatalog() {
      return options.catalog ? options.catalog() : catalog();
    },
  };
  const port = withEnterpriseConnectorServers(inner.port, {
    authorization,
    catalog: catalogPort,
    connectors: connectors.port,
    sessionId: "session",
    traceContext,
    workspacePath: "/controlled",
  });
  return { admissions, connectors, inner, port };
}

const serverName = `enterprise-${connector.asset.id}`;

test("connector tools join the existing MCP owner with normalized names and schemas", async () => {
  const f = owner();
  const snapshot = await f.port.connectConfiguredServers({});
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), [`mcp__enterprise-controlled-connector__multiply`]);
  assert.equal(snapshot.statuses[serverName]?.status, "connected");
  assert.equal(snapshot.statuses[serverName]?.transport, "http");
  assert.equal(snapshot.statuses[serverName]?.toolCount, 1);
  // 零配置 server 的启动路径也会发现连接器工具。
  assert.deepEqual((await f.port.listTools()).map((tool) => tool.name), [
    "mcp__enterprise-controlled-connector__multiply",
  ]);
  assert.deepEqual(Object.keys(await f.port.status()), [serverName]);
  const methods = f.connectors.frames.map((frame) => frame.method);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
  // 逐次准入：连接前后各一次，绑定当前目录 ownerKey 与不可变版本。
  assert.equal(f.admissions.length, 2);
  assert.deepEqual(f.admissions[0]?.asset, { asset: connector.asset });
  assert.equal(f.admissions[0]?.ownerKey, ownerKey);
  assert.equal(f.admissions[0]?.phase, "asset_load");
  assert.equal(f.admissions[0]?.capability.assetGuarded, true);
});

test("connector tool calls are admitted before and after and reuse the backend session", async () => {
  const f = owner();
  await f.port.connectConfiguredServers({});
  const result = await f.port.callTool({
    serverName,
    toolName: "multiply",
    arguments: { left: 6, right: 7 },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "42" }]);
  const call = f.connectors.frames.at(-1)!;
  assert.equal(call.method, "tools/call");
  assert.deepEqual(call.params, { name: "multiply", arguments: { left: 6, right: 7 } });
  assert.equal(call.session, "session-1");
  // 加载两次 + 调用前后两次。
  assert.equal(f.admissions.length, 4);
  assert.deepEqual(f.inner.calls, [], "连接器调用不落到内部端口");
});

test("a revoked connector loses its tools and never falls back to the inner port", async () => {
  let revoked = false;
  const f = owner({
    authorization: () =>
      revoked ? { allowed: false, code: "enterprise_asset_denied" } : { allowed: true, code: "allowed" },
  });
  await f.port.connectConfiguredServers({});
  assert.equal((await f.port.listTools()).length, 1);
  revoked = true;
  // 撤权后已注册的工具在下次调用时失败关闭，不回落到内部端口，也不返回缓存内容。
  await assert.rejects(
    () => f.port.callTool({ serverName, toolName: "multiply" }),
    /enterprise_asset_denied/,
  );
  assert.deepEqual(f.inner.calls, []);
  assert.equal(
    f.connectors.frames.filter((frame) => frame.method === "tools/call").length,
    0,
    "撤权后不再向连接器发送调用帧",
  );
});

test("a catalog without the connector prunes it and releases the backend session", async () => {
  let connectors = [connector];
  const f = owner({ catalog: () => catalog(connectors) });
  await f.port.connectConfiguredServers({});
  assert.equal((await f.port.listTools()).length, 1);
  connectors = [];
  await f.port.connectConfiguredServers({});
  assert.deepEqual(await f.port.listTools(), []);
  assert.deepEqual(f.connectors.releases, ["session-1"]);
  assert.equal(f.connectors.sessions(), 1);
});

test("a published version change reconnects with a fresh session and drops the old one", async () => {
  let version = 1;
  const f = owner({
    catalog: () =>
      catalog([
        {
          ...connector,
          asset: { ...connector.asset, version, checksum: version === 2 ? "c".repeat(64) : connector.asset.checksum },
        },
      ]),
  });
  await f.port.connectConfiguredServers({});
  version = 2;
  await f.port.connectConfiguredServers({});
  assert.equal(f.connectors.sessions(), 2);
  assert.deepEqual(f.connectors.releases, ["session-1"]);
  assert.equal((await f.port.listTools()).length, 1);
});

test("a configured server keeps the reserved enterprise name", async () => {
  const f = owner();
  const configured: Record<string, McpServerConfig> = {
    [serverName]: { type: "stdio", command: "controlled" },
  };
  await f.port.connectConfiguredServers(configured);
  assert.deepEqual(await f.port.listTools(), []);
  assert.deepEqual(Object.keys(await f.port.status()), []);
  assert.deepEqual(f.connectors.frames, []);
  assert.equal(f.inner.connected.length, 1);
});

test("a denied or cancelled catalog yields no connector tools and no fallback", async () => {
  const denied = owner({
    catalog: () => ({ status: "denied", code: "enterprise_asset_denied" }),
  });
  await denied.port.connectConfiguredServers({});
  assert.deepEqual(await denied.port.listTools(), []);
  assert.deepEqual(denied.connectors.frames, []);

  const unmanaged = owner({ catalog: () => ({ status: "unmanaged" }) });
  await unmanaged.port.connectConfiguredServers({});
  assert.deepEqual(await unmanaged.port.listTools(), []);

  // 未被接管时端口保持原样：独立 CLI 完全不走企业通道。
  const inner = innerPort();
  const untouched = withEnterpriseConnectorServers(inner.port, {
    sessionId: "session",
    traceContext,
    workspacePath: "/controlled",
  });
  assert.equal(untouched, inner.port);
});

test("closing the MCP owner releases every connector session", async () => {
  const f = owner();
  await f.port.connectConfiguredServers({});
  await f.port.close();
  assert.deepEqual(f.connectors.releases, ["session-1"]);
});

test("disconnecting a connector server releases only that session", async () => {
  const f = owner();
  await f.port.connectConfiguredServers({});
  const status = await f.port.disconnectServer(serverName);
  assert.equal(status?.status, "disconnected");
  assert.deepEqual(f.connectors.releases, ["session-1"]);
  assert.deepEqual(await f.port.listTools(), []);
  // 其他 server 仍下沉给内部所有者。
  assert.equal(await f.port.disconnectServer("unrelated"), undefined);
});
