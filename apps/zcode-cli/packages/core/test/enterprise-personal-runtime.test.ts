import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zcodeProtocolMcpServerSchema } from "@zcode/shared";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";
import type { UWorkBackendSession } from "../../../../../packages/services/src/enterprise-identity/backendSessionContract.js";
import { createUWorkToolAuthorizationResolver } from "../../../../../packages/services/src/enterprise-identity/uworkToolAuthorization.js";
import { createProviderRuntime } from "../../../../../packages/services/src/model-provider/providerRuntime.js";
import { ApiProviderModelRuntime } from "../../bootstrap/src/app/provider-registry-model-runtime.js";
import { createRuntimeAssetGuards } from "../../bootstrap/src/app/enterprise-runtime-assets.js";
import { AiSdkModelAdapter } from "../../adapters/src/model/runner.js";
import { createMcpAdapter } from "../../adapters/src/mcp/index.js";
import { createNetworkProxyFetch } from "../../adapters/src/network/proxy-fetch.js";
import { resolveBuiltInNodeReplMcpServers } from "../../bootstrap/src/app/built-in-node-repl.js";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
} from "../../bootstrap/src/app/official-plugin-definitions.js";

function authority() {
  const state = {
    personal: { models: false, skills: false, connectors: false },
    ownerKey: "a".repeat(64),
    origin: "https://backend.example.test",
    status: 200,
    requests: 0,
    targets: [] as unknown[],
    managed: true,
    afterDecision: undefined as (() => void) | undefined,
  };
  const backendSession: UWorkBackendSession = {
    async run(operation) {
      if (!state.managed) return { managed: false };
      const value = await operation({
        ownerKey: state.ownerKey,
        origin: state.origin,
        tenantId: "tenant",
        memberId: "member",
        signal: new AbortController().signal,
        isCurrent: () => true,
        assertCurrent: async () => {},
        async request() {
          state.requests++;
          const body = {
            allowed: true,
            tenantId: "tenant",
            personal: { ...state.personal },
            security: {
              allowShell: true,
              allowFilesystem: true,
              allowNetwork: true,
              dangerousSkills: false,
              allowedDomains: [],
            },
          };
          state.afterDecision?.();
          return { status: state.status, body };
        },
      });
      return { managed: true, value };
    },
  };
  const resolver = createUWorkToolAuthorizationResolver({ backendSession });
  const guards = createRuntimeAssetGuards({
    authorization: {
      authorize: (request, signal) => {
        state.targets.push(request.input);
        return resolver.authorize(
          {
            ...request,
            requestId: "controlled",
            workspace: {
              workspacePath: request.workspacePath,
              workspaceKey: request.workspacePath,
            },
          },
          signal,
        );
      },
    },
    sessionId: "controlled",
    workspacePath: "/controlled",
    traceContext: createRootTraceContext({ sessionId: createSessionId("controlled") }),
  })!;
  return { state, guards };
}

async function modelFixture(t: TestContext) {
  let calls = 0;
  let respond: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    calls++;
    let input = "";
    for await (const chunk of req) input += chunk;
    respond?.();
    if (JSON.parse(input).stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: { role: "assistant", content: "controlled late text" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "controlled",
        object: "chat.completion",
        created: 1,
        model: "controlled",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "controlled success" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const directory = await mkdtemp(join(tmpdir(), "uwork-personal-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createProviderRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(directory, "personal.json"),
    watch: false,
    personalPollingIntervalMs: false,
  });
  t.after(() => registry.dispose());
  await registry.start();
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const provider = await registry.providerSettings.createPersonalProvider({
    providerName: "UCAS",
    initialConfig: {
      api: { type: "openai-chat-completions", baseUrl },
      access: { type: "api-key", apiKey: "synthetic-only" },
    },
  });
  await registry.providerSettings.addPersonalModel(provider.providerId, "controlled", {}, true);
  await registry.registryService.refresh("controlled");
  const f = authority();
  const owner = new ApiProviderModelRuntime({
    registry: registry.registryService,
    modelAdapter: new AiSdkModelAdapter({ env: {}, beforeDispatch: f.guards.model }),
    authorization: f.guards.model,
  });
  owner.start();
  t.after(() => owner.dispose());
  const registered = registry.registryService.getModel(provider.providerId, "controlled")!;
  const model = owner.modelFactory({
    selection: {
      providerId: provider.providerId,
      modelId: "controlled",
      options: { reasoningLevel: registered.config.optionSpecs.reasoningLevel.values[0]! },
    },
  });
  const request = {
    messages: [{ role: "user" as const, content: "controlled" }],
    options: { maxOutputTokens: 32 },
  };
  return {
    ...f,
    model,
    request,
    baseUrl,
    calls: () => calls,
    onResponse: (fn: () => void) => {
      respond = fn;
    },
  };
}

test("a real Registry/SDK personal model cannot send even when its display name copies UCAS", async (t) => {
  const f = await modelFixture(t);
  await assert.rejects(f.model.generateText(f.request), /enterprise_personal_models_denied/);
  assert.equal(f.calls(), 0);
});
test("runtime admission sends no URL credentials or query secrets over the private RPC", async () => {
  const f = authority();
  f.state.personal.models = true;
  await f.guards.model("https://models.example.test/v1?api_key=synthetic-query");
  assert.deepEqual(f.state.targets, [{ url: "https://models.example.test/v1" }]);
});
test("runtime admission rejects credentials, fragments and non-HTTP schemes before RPC", async () => {
  const f = authority();
  f.state.personal.models = true;
  for (const url of [
    "https://controlled:synthetic-only@backend.example.test/v1",
    "https://backend.example.test/v1#fragment",
    "file:///controlled",
  ])
    await assert.rejects(f.guards.model(url), /enterprise_runtime_target_invalid/);
  assert.deepEqual(f.state.targets, []);
});
test("only the actual builtin registration supplies the private connector provenance", async () => {
  const input = {
    workingDirectory: "/controlled",
    pluginOutcome: {
      plugins: [
        { id: OFFICIAL_BROWSER_USE_PLUGIN_ID, enabled: true, rootPath: "/controlled/browser" },
        { id: OFFICIAL_NODE_REPL_HOST_PLUGIN_ID, enabled: true, rootPath: "/controlled/host" },
      ],
    },
  } as unknown as Parameters<typeof resolveBuiltInNodeReplMcpServers>[0];
  const servers = resolveBuiltInNodeReplMcpServers(input);
  assert.deepEqual(servers.node_repl?.source, { kind: "builtin" });
  const f = authority();
  await f.guards.connector(servers.node_repl!);
  await assert.rejects(
    f.guards.connector({ type: "stdio", command: "controlled" }),
    /enterprise_personal_connectors_denied/,
  );
});
test("current managed gateway origin remains usable with personal models disabled", async (t) => {
  const f = await modelFixture(t);
  f.state.origin = new URL(f.baseUrl).origin;
  await f.model.generateText(f.request);
  assert.equal(f.calls(), 1);
});
test("actual SDK HTTP dispatch rechecks a personal permission withdrawn after Model admission", async (t) => {
  const f = await modelFixture(t);
  f.state.personal.models = true;
  f.state.afterDecision = () => {
    if (f.state.requests === 1) f.state.personal.models = false;
  };
  await assert.rejects(f.model.generateText(f.request));
  assert.equal(f.calls(), 0);
});
test("explicit unmanaged behavior still permits existing personal model HTTP", async (t) => {
  const f = await modelFixture(t);
  f.state.managed = false;
  await f.model.generateText(f.request);
  assert.equal(f.calls(), 1);
  assert.equal(f.state.requests, 0);
});
test("a real SDK stream withholds its next event after personal policy revocation", async (t) => {
  const f = await modelFixture(t);
  f.state.personal.models = true;
  f.onResponse(() => {
    f.state.personal.models = false;
  });
  let events = 0;
  await assert.rejects(async () => {
    for await (const _event of f.model.streamText(f.request)) events++;
  }, /enterprise_personal_models_denied/);
  assert.equal(events, 0);
  assert.equal(f.calls(), 1);
});
for (const mutation of ["permission", "owner", "channel", "unmanaged"] as const)
  test(`a bound real SDK model withholds a late HTTP result after ${mutation} changes`, async (t) => {
    const f = await modelFixture(t);
    f.state.personal.models = true;
    f.onResponse(() => {
      if (mutation === "permission") f.state.personal.models = false;
      if (mutation === "owner") f.state.ownerKey = "b".repeat(64);
      if (mutation === "channel") f.state.status = 403;
      if (mutation === "unmanaged") f.state.managed = false;
    });
    await assert.rejects(
      f.model.bind({ maxOutputTokens: 32 }).generateText(f.request),
      /enterprise_/,
    );
    assert.equal(f.calls(), 1);
  });

async function mcpFixture(t: TestContext) {
  const methods: string[] = [];
  let afterCall: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as { method: string; id?: number };
    methods.push(body.method);
    if (body.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (body.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "controlled", version: "1" },
      };
    if (body.method === "tools/list")
      result = { tools: [{ name: "controlled", inputSchema: { type: "object", properties: {} } }] };
    if (body.method === "tools/call") {
      afterCall?.();
      result = { content: [{ type: "text", text: "controlled success" }] };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const f = authority();
  const port = createMcpAdapter({ env: {}, beforeDispatch: f.guards.connector });
  t.after(() => port.close());
  const config = {
    type: "http" as const,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/rpc`,
    protocolVersion: "legacy" as const,
  };
  const call = { serverName: "personal", toolName: "controlled", arguments: {} };
  return {
    ...f,
    port,
    config,
    call,
    methods,
    afterCall: (fn: () => void) => {
      afterCall = fn;
    },
  };
}
test("a real MCP owner refuses personal and unknown-source servers before remote initialize", async (t) => {
  const f = await mcpFixture(t);
  const status = await f.port.connectServer("personal", {
    ...f.config,
    source: { kind: "plugin" },
  });
  assert.equal(status.status, "failed");
  assert.deepEqual(f.methods, []);
  assert.equal(
    zcodeProtocolMcpServerSchema.safeParse({
      name: "personal",
      ...f.config,
      headers: [],
      source: { kind: "builtin" },
    }).success,
    false,
  );
});
test("a real MCP HTTP dispatch rechecks a permission withdrawn during connection setup", async (t) => {
  const f = await mcpFixture(t);
  f.state.personal.connectors = true;
  f.state.afterDecision = () => {
    if (f.state.requests === 1) f.state.personal.connectors = false;
  };
  assert.equal((await f.port.connectServer("personal", f.config)).status, "failed");
  assert.deepEqual(f.methods, []);
});
test("explicit unmanaged MCP retains its existing connection and tool behavior", async (t) => {
  const f = await mcpFixture(t);
  f.state.managed = false;
  assert.equal((await f.port.connectServer("personal", f.config)).status, "connected");
  assert.ok((await f.port.callTool(f.call)).content.length);
  assert.equal(f.state.requests, 0);
});
for (const mutation of ["permission", "owner", "unmanaged"] as const)
  test(`a real personal MCP call rechecks ${mutation} and suppresses a late result`, async (t) => {
    const f = await mcpFixture(t);
    f.state.personal.connectors = true;
    assert.equal((await f.port.connectServer("personal", f.config)).status, "connected");
    f.afterCall(() => {
      if (mutation === "permission") f.state.personal.connectors = false;
      else if (mutation === "owner") f.state.ownerKey = "b".repeat(64);
      else f.state.managed = false;
    });
    await assert.rejects(f.port.callTool(f.call), /enterprise_/);
    assert.equal(f.methods.filter((m) => m === "tools/call").length, 1);
    await assert.rejects(f.port.callTool(f.call));
    assert.equal(f.methods.filter((m) => m === "tools/call").length, 1);
  });

test("the real CA transport returns a redirect without following its forbidden destination", async (t) => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === "/start") res.writeHead(302, { location: "/forbidden" }).end();
    else res.end("unexpected");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const directory = await mkdtemp(join(tmpdir(), "uwork-ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificate = join(directory, "empty-ca.pem");
  await writeFile(certificate, "");
  const request = createNetworkProxyFetch({
    env: {},
    caCertFile: certificate,
    beforeDispatch: async () => true,
  });
  const response = await request(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/start`,
  );
  assert.equal(response.status, 302);
  await response.body?.cancel();
  assert.equal(requests, 1);
});
