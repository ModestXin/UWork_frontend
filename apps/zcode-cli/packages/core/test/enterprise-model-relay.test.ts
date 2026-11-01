import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRegistryProviderConfig,
  createRegistryModelConfig,
  parseProviderConfig,
  parseModelConfig,
} from "../../../../../packages/provider/src/index.js";
import { AiSdkModelAdapter } from "../../adapters/src/model/runner.js";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";

function config() {
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "enterprise-session" },
      api: { type: "openai-chat-completions", baseUrl: "https://backend.example.test/v1" },
    }),
  );
  const model = createRegistryModelConfig(
    parseModelConfig({
      enabled: true,
      properties: {
        contextWindow: 128000,
        requiresMfjsToolSchema: false,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: false,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      },
      optionSpecs: {
        reasoningLevel: { values: ["none"], map: "{}" },
        maxOutputTokens: { max: 16, map: '{"max_tokens":maxOutputTokens}' },
      },
    }),
  );
  assert.ok(provider.ok && model.ok);
  return {
    providerId: "ucas",
    modelId: "controlled",
    providerConfig: provider.config,
    modelConfig: model.config,
  };
}

test("enterprise-session cannot create an executable SDK model without private relay", () => {
  assert.throws(
    () => new AiSdkModelAdapter({ env: {} }).createModel(config()),
    /enterprise_model_relay_unavailable/,
  );
});

async function fixture(chunks: Buffer[], status = 200) {
  const { createEnterpriseSessionFetch } =
    await import("../../adapters/src/model/enterprise-session-fetch.js");
  const calls: { kind: string; [key: string]: unknown }[] = [];
  const relay = {
    async request(input: { request: { kind: string; [key: string]: unknown } }) {
      calls.push(input.request);
      if (input.request.kind === "open")
        return {
          status: "ok" as const,
          streamId: "stream",
          httpStatus: status,
          contentType: "application/json" as const,
        };
      if (input.request.kind === "close") return { status: "ok" as const, done: true };
      const chunk = chunks.shift();
      return { status: "ok" as const, chunk: chunk?.toString("base64"), done: !chunk };
    },
  };
  const fetch = createEnterpriseSessionFetch({
    getOwnerKey: () => "a".repeat(64),
    relay,
    sessionId: "controlled",
    workspacePath: "/controlled",
    traceContext: createRootTraceContext({ sessionId: createSessionId("controlled") }),
  });
  return { fetch, calls };
}

test("relay Response preserves UTF8 bytes and closes EOF without exposing any headers", async () => {
  const bytes = Buffer.from('{"text":"中文😀"}');
  const f = await fixture(Array.from(bytes, (byte) => Buffer.from([byte])));
  const response = await f.fetch("https://backend.example.test/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer must-not-cross-private-port" },
    body: '{"model":"controlled","messages":[]}',
  });
  assert.deepEqual(await response.json(), { text: "中文😀" });
  assert.equal(f.calls.at(-1)?.kind, "close");
  assert.ok(!JSON.stringify(f.calls).includes("must-not-cross-private-port"));
});

test("relay preserves HTTP errors for SDK instead of treating them as an empty completion", async () => {
  const f = await fixture([Buffer.from('{"error":{"code":"REVOKED"}}')], 403);
  const response = await f.fetch("https://backend.example.test/v1/chat/completions", {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "REVOKED");
});

test("Response consumer cancellation closes the Host stream", async () => {
  const f = await fixture([Buffer.from("pending")]);
  const response = await f.fetch("https://backend.example.test/v1/chat/completions", {
    method: "POST",
    body: "{}",
  });
  await response.body!.cancel();
  assert.equal(f.calls.at(-1)?.kind, "close");
});

test("private protocol cancels a pending open without waiting for streamId", async () => {
  const { createProtocolEnterpriseModelRelay } =
    await import("../../bootstrap/src/zcode-protocol/enterprise-model-relay.js");
  const { createEnterpriseSessionFetch } =
    await import("../../adapters/src/model/enterprise-session-fetch.js");
  const notices: unknown[] = [];
  let reached!: () => void;
  const pending = new Promise<void>((done) => {
    reached = done;
  });
  const port = createProtocolEnterpriseModelRelay({
    workspace: () => ({ workspacePath: "/controlled", workspaceKey: "/controlled" }),
    context: () => ({
      requestClient: async (_method, _params, _schema, options) => {
        reached();
        return new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          }),
        );
      },
      notify: (message) => {
        notices.push(message);
      },
    }),
  });
  const relayFetch = createEnterpriseSessionFetch({
    getOwnerKey: () => "a".repeat(64),
    relay: port,
    sessionId: "controlled",
    workspacePath: "/controlled",
    traceContext: createRootTraceContext({ sessionId: createSessionId("controlled") }),
  });
  const controller = new AbortController();
  const request = relayFetch("https://backend.example.test/v1/chat/completions", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  await pending;
  controller.abort(new Error("synthetic-stop"));
  await assert.rejects(request, /synthetic-stop/);
  assert.equal(notices.length, 1);
  assert.ok(JSON.stringify(notices).includes("enterprise-model:"));
});

test("late open after abort is closed and cannot expose a Response", async () => {
  const { createEnterpriseSessionFetch } =
    await import("../../adapters/src/model/enterprise-session-fetch.js");
  let release!: (value: unknown) => void;
  const pending = new Promise<unknown>((done) => {
    release = done;
  });
  let reached!: () => void;
  const admitted = new Promise<void>((done) => {
    reached = done;
  });
  const calls: string[] = [];
  const relay = {
    async request(input: { request: { kind: string } }) {
      calls.push(input.request.kind);
      if (input.request.kind === "open") {
        reached();
        return (await pending) as {
          status: "ok";
          streamId: string;
          httpStatus: number;
          contentType: "application/json";
        };
      }
      return { status: "ok" as const, done: true };
    },
  };
  const fetch = createEnterpriseSessionFetch({
    getOwnerKey: () => "a".repeat(64),
    relay,
    sessionId: "controlled",
    workspacePath: "/controlled",
    traceContext: createRootTraceContext({ sessionId: createSessionId("controlled") }),
  });
  const controller = new AbortController();
  const opening = fetch("https://backend.example.test/v1/chat/completions", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  await admitted;
  controller.abort(new Error("synthetic-stop"));
  release({ status: "ok", streamId: "late", httpStatus: 200, contentType: "application/json" });
  await assert.rejects(opening, /synthetic-stop/);
  assert.deepEqual(calls, ["open", "close"]);
});

test("actual SDK JSON generation uses private relay and does not contact configured origin", async () => {
  const payload = JSON.stringify({
    id: "synthetic",
    object: "chat.completion",
    created: 1,
    model: "controlled",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "private result" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
  const f = await fixture([Buffer.from(payload)]);
  const model = new AiSdkModelAdapter({ env: {}, enterpriseSessionFetch: f.fetch }).createModel(
    config(),
  );
  const result = await model.generateText({
    messages: [{ role: "user", content: "synthetic" }],
    options: { reasoningLevel: "none", maxOutputTokens: 8 },
  });
  assert.equal(result.text, "private result");
  assert.equal(result.usage.totalTokens, 3);
  assert.deepEqual(Object.keys(f.calls[0]!).sort(), ["body", "kind", "ownerKey", "url"]);
  assert.equal(f.calls[0]!.ownerKey, "a".repeat(64));
  const body = JSON.parse(String(f.calls[0]!.body));
  assert.equal(body.max_tokens, 8);
});

test("bootstrap model factory forwards the trusted dispatch guard before actual personal HTTP", async (t) => {
  const { createServer } = await import("node:http");
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
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
            message: { role: "assistant", content: "wrongly admitted" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const { createModelAdapter } = await import("../../bootstrap/src/model-factory.js");
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "synthetic-personal" },
      api: {
        type: "openai-chat-completions",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      },
    }),
  );
  assert.ok(provider.ok);
  const adapter = createModelAdapter({
    executionConfig: {},
    env: { ZCODE_MODEL_RETRY_MAX_RETRIES: "0" },
    beforeDispatch: async () => {
      throw new Error("synthetic_dispatch_denied");
    },
  });
  const model = adapter.createModel({ ...config(), providerConfig: provider.config });
  await assert.rejects(
    model.generateText({
      messages: [{ role: "user", content: "controlled" }],
      options: { maxOutputTokens: 8, reasoningLevel: "none" },
    }),
    (error: unknown) => {
      let current = error;
      for (let i = 0; i < 8 && current instanceof Error; i++) {
        if (current.message === "synthetic_dispatch_denied") return true;
        current = current.cause;
      }
      return false;
    },
  );
  assert.equal(calls, 0);
});

test("text-only model still rejects explicitly requested tools before Host relay dispatch", async () => {
  const f = await fixture([]);
  const model = new AiSdkModelAdapter({ env: {}, enterpriseSessionFetch: f.fetch }).createModel(
    config(),
  );
  await assert.rejects(
    model.generateText({
      messages: [{ role: "user", content: "explicit required tool" }],
      tools: [{ name: "ExplicitTool", inputSchema: { type: "object", properties: {} } }],
      options: { reasoningLevel: "none", maxOutputTokens: 8 },
    }),
    /does not support tool calls/,
  );
  assert.equal(f.calls.length, 0);
});
