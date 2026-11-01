import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import { createEnterpriseModelRelay } from "../src/enterprise-model-relay/relay.js";

async function fixture(t: TestContext) {
  const controller = new AbortController();
  const token = "synthetic-private-independent-session";
  const escaped = Array.from(
    token,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ).join("");
  let requests = 0;
  const server = createServer(async (req, res) => {
    req.resume();
    requests++;
    res.setHeader("content-type", "application/json");
    if (req.headers["x-zcode-trace-id"] === "encoded-error") {
      res.statusCode = 403;
      res.end(`{"error":{"message":"${escaped}"}}`);
    } else if (req.headers["x-zcode-trace-id"] === "encoded-sse") {
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: {"choices":[{"delta":{"content":"${escaped}"}}]}\n\ndata: [DONE]\n\n`);
    } else if (req.headers["x-zcode-trace-id"] === "fragmented-sse") {
      res.setHeader("content-type", "text/event-stream");
      const middle = Math.floor(token.length / 2);
      res.write(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(token.slice(0, middle))}}}]}\n\n`,
      );
      setImmediate(() =>
        res.end(
          `data: {"choices":[{"delta":{"content":${JSON.stringify(token.slice(middle))}}}]}\n\ndata: [DONE]\n\n`,
        ),
      );
    } else if (
      ["tool-json", "tool-split-escape"].includes(String(req.headers["x-zcode-trace-id"]))
    ) {
      res.setHeader("content-type", "text/event-stream");
      const argumentsText = `{"text":"${escaped}"}`;
      const delta = (argumentsPart: string) =>
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argumentsPart } }] } }] })}\n\n`;
      if (req.headers["x-zcode-trace-id"] === "tool-json")
        res.end(delta(argumentsText) + "data: [DONE]\n\n");
      else {
        res.write(delta(argumentsText.slice(0, 12)));
        setImmediate(() => res.end(delta(argumentsText.slice(12)) + "data: [DONE]\n\n"));
      }
    } else {
      res.write(" ".repeat(256));
      // A valid JSON prefix holds each real HTTP response open until abort.
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = {
    token,
    issuerOrigin: origin,
    expiresAt: Date.now() + 60000,
    profile: {
      id: "member",
      tenantId: "tenant",
      provider: "wecom" as const,
      displayName: "Synthetic",
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
  const relay = createEnterpriseModelRelay({ backendSession });
  t.after(async () => {
    relay.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return { relay, origin, token, requests: () => requests, ownerKey };
}

for (const mode of ["tool-json", "tool-split-escape"]) {
  test(`independent audit: ${mode} cannot reveal session through decoded tool arguments`, async (t) => {
    const f = await fixture(t);
    const binding = {
      runtime: {},
      workspaceKey: "workspace",
      sessionId: "session",
    };
    const opened = await f.relay.request({
      ...binding,
      traceId: mode,
      request: {
        kind: "open",
        ownerKey: f.ownerKey,
        url: `${f.origin}/v1/chat/completions`,
        body: "{}",
      },
    });
    assert.ok(opened.status === "ok" && opened.streamId);
    const chunks: Buffer[] = [];
    for (let i = 0; i < 8; i++) {
      const result = await f.relay.request({
        ...binding,
        request: { kind: "read", streamId: opened.streamId },
      });
      if (result.status === "denied") break;
      if (result.chunk) chunks.push(Buffer.from(result.chunk, "base64"));
      if (result.done) break;
    }
    const argumentsText = Buffer.concat(chunks)
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
      .map(
        (line) =>
          (
            JSON.parse(line.slice(5)) as {
              choices: {
                delta: { tool_calls: { function: { arguments: string } }[] };
              }[];
            }
          ).choices[0]!.delta.tool_calls[0]!.function.arguments,
      )
      .join("");
    let leaked = false;
    if (argumentsText) {
      try {
        leaked = (JSON.parse(argumentsText) as { text: string }).text === f.token;
      } catch {
        leaked = argumentsText.includes("\\u0073\\u0079");
      }
    }
    assert.equal(
      leaked,
      false,
      "decoded nested JSON arguments cannot carry private session or its escaped prefix",
    );
  });
}

test("independent audit: all 32 cross-workspace streams are reclaimed by runtime close", async (t) => {
  const f = await fixture(t);
  const runtime = {},
    otherRuntime = {};
  const entries: {
    workspaceKey: string;
    sessionId: string;
    streamId: string;
  }[] = [];
  for (let i = 0; i < 32; i++) {
    const binding = {
      runtime,
      workspaceKey: `workspace-${i}`,
      sessionId: `conversation-${i}`,
    };
    const opened = await f.relay.request({
      ...binding,
      request: {
        kind: "open",
        ownerKey: f.ownerKey,
        url: `${f.origin}/v1/chat/completions`,
        body: "{}",
      },
    });
    assert.ok(opened.status === "ok" && opened.streamId);
    entries.push({
      workspaceKey: binding.workspaceKey,
      sessionId: binding.sessionId,
      streamId: opened.streamId,
    });
  }
  assert.equal(f.requests(), 32);
  for (const forged of [
    {
      runtime: otherRuntime,
      workspaceKey: entries[0]!.workspaceKey,
      sessionId: entries[0]!.sessionId,
    },
    {
      runtime,
      workspaceKey: entries[1]!.workspaceKey,
      sessionId: entries[0]!.sessionId,
    },
    {
      runtime,
      workspaceKey: entries[0]!.workspaceKey,
      sessionId: entries[1]!.sessionId,
    },
  ]) {
    for (const kind of ["read", "close"] as const) {
      const result = await f.relay.request({
        ...forged,
        request: { kind, streamId: entries[0]!.streamId },
      });
      assert.deepEqual(result, {
        status: "denied",
        code: "enterprise_model_binding_mismatch",
      });
    }
  }
  const overflow = await f.relay.request({
    runtime: otherRuntime,
    workspaceKey: "other",
    sessionId: "other",
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: "{}",
    },
  });
  assert.deepEqual(overflow, {
    status: "denied",
    code: "enterprise_model_limit",
  });
  assert.equal(f.requests(), 32);
  let pendingReadFinished = false;
  const pendingRead = f.relay
    .request({
      runtime,
      ...entries[0]!,
      request: { kind: "read", streamId: entries[0]!.streamId },
    })
    .then((result) => {
      pendingReadFinished = true;
      return result;
    });
  f.relay.closeRuntime(otherRuntime);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(pendingReadFinished, false, "other runtime cannot terminate an owned read");
  f.relay.closeRuntime(runtime);
  assert.equal((await pendingRead).status, "denied");
  for (const entry of entries) {
    const result = await f.relay.request({
      runtime,
      ...entry,
      request: { kind: "read", streamId: entry.streamId },
    });
    assert.deepEqual(result, {
      status: "denied",
      code: "enterprise_model_stream_closed",
    });
  }
  const next = await f.relay.request({
    runtime: otherRuntime,
    workspaceKey: "other",
    sessionId: "other",
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: "{}",
    },
  });
  assert.ok(next.status === "ok" && next.streamId);
  assert.equal(f.requests(), 33);
});

for (const mode of ["encoded-sse", "fragmented-sse"]) {
  test(`independent audit: ${mode} cannot reveal a private token or its held prefix`, async (t) => {
    const f = await fixture(t);
    const binding = {
      runtime: {},
      workspaceKey: "workspace",
      sessionId: "session",
    };
    const opened = await f.relay.request({
      ...binding,
      traceId: mode,
      request: {
        kind: "open",
        ownerKey: f.ownerKey,
        url: `${f.origin}/v1/chat/completions`,
        body: "{}",
      },
    });
    assert.ok(opened.status === "ok" && opened.streamId);
    const chunks: Buffer[] = [];
    for (let i = 0; i < 8; i++) {
      const result = await f.relay.request({
        ...binding,
        request: { kind: "read", streamId: opened.streamId },
      });
      if (result.status === "denied") break;
      if (result.chunk) chunks.push(Buffer.from(result.chunk, "base64"));
      if (result.done) break;
    }
    const decoded = Buffer.concat(chunks)
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
      .map(
        (line) =>
          (
            JSON.parse(line.slice(5)) as {
              choices: { delta: { content: string } }[];
            }
          ).choices[0]!.delta.content,
      )
      .join("");
    const privatePrefixLeaked = decoded.length > 0 && f.token.startsWith(decoded);
    assert.equal(
      privatePrefixLeaked,
      false,
      "no private session prefix may reach CLI semantic model output",
    );
  });
}

test("independent audit: escaped JSON errors cannot carry private session token to CLI", async (t) => {
  const f = await fixture(t);
  const binding = {
    runtime: {},
    workspaceKey: "workspace",
    sessionId: "session",
  };
  const opened = await f.relay.request({
    ...binding,
    traceId: "encoded-error",
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: "{}",
    },
  });
  assert.ok(opened.status === "ok" && opened.streamId);
  const chunks: Buffer[] = [];
  let denied = false;
  for (let i = 0; i < 8; i++) {
    const result = await f.relay.request({
      ...binding,
      request: { kind: "read", streamId: opened.streamId },
    });
    if (result.status === "denied") {
      denied = true;
      break;
    }
    if (result.chunk) chunks.push(Buffer.from(result.chunk, "base64"));
    if (result.done) break;
  }
  const leaked =
    !denied &&
    (
      JSON.parse(Buffer.concat(chunks).toString()) as {
        error: { message: string };
      }
    ).error.message === f.token;
  assert.equal(leaked, false, "decoded JSON error must not reveal private session to CLI");
});
