import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Emitter } from "@zcode/rpc";
import { createEnterpriseToolAuthorizationBridge } from "../src/zcode-agent/enterpriseToolAuthorizationBridge.js";
import { createHostApiNetworkTransport } from "../src/providers/api/nodeApiNetwork.js";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import { createEnterpriseModelRelay } from "../src/enterprise-model-relay/relay.js";
async function fixture(t: import("node:test").TestContext, fetchImpl?: typeof fetch) {
  let notifyRequest!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  const controller = new AbortController(),
    token = "synthetic-private-model-session";
  const requests: { authorization?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ authorization: req.headers.authorization, body });
    notifyRequest();
    if (body.includes("beforeheaders")) return;
    if (body.includes("echo-tools")) {
      const escaped = Array.from(
        token,
        (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
      ).join("");
      const args = '{"credential":"' + escaped + '"}';
      const middle = body.includes("fragmented") ? 20 : args.length;
      const frame = (argumentsPart: string) =>
        "data: " +
        JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: argumentsPart } }] } },
          ],
        }) +
        "\n\n";
      res.setHeader("content-type", "text/event-stream");
      res.write(frame(args.slice(0, middle)));
      setImmediate(() =>
        res.end((middle < args.length ? frame(args.slice(middle)) : "") + "data: [DONE]\n\n"),
      );
      return;
    }
    if (body.includes("http-error")) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"error":{"code":"FORBIDDEN"}}');
      return;
    }
    if (body.includes("echo-private")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(token.slice(0, 12));
      setImmediate(() => res.end(token.slice(12)));
      return;
    }
    if (body.includes("oversized-response")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(8 * 1024 * 1024 + 1));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    if (!body.includes("hold")) res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
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
    fetchImpl,
    resolveConfig: async () => ({ backend: "uwork", apiBaseUrl: origin }),
    readAuthority: () => ({ generation: 1, revision: 1, session, signal: controller.signal }),
    readPersistedSession: async () => ({ revision: 1, session }),
  });
  const proof = await backendSession.run(async (scope) => scope.ownerKey);
  assert.ok(proof.managed);
  const ownerKey = proof.value;
  const relay = createEnterpriseModelRelay({ backendSession });
  const binding = { runtime: {}, workspaceKey: "workspace", sessionId: "conversation" };
  t.after(async () => {
    relay.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { relay, binding, origin, requests, controller, token, requestSeen, ownerKey };
}
test("real TCP model relay keeps session private and preserves SSE bytes", async (t) => {
  const f = await fixture(t);
  const open = await f.relay.request({
    ...f.binding,
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: '{"model":"synthetic"}',
    },
  });
  assert.ok(open.status === "ok" && open.streamId);
  const parts: Buffer[] = [];
  for (;;) {
    const result = await f.relay.request({
      ...f.binding,
      request: { kind: "read", streamId: open.streamId },
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") break;
    if (result.chunk) parts.push(Buffer.from(result.chunk, "base64"));
    assert.ok(!JSON.stringify(result).includes(f.token));
    if (result.done) break;
  }
  assert.match(Buffer.concat(parts).toString(), /hello/);
  assert.match(Buffer.concat(parts).toString(), /\[DONE\]/);
  assert.equal(f.requests[0]?.authorization, `Bearer ${f.token}`);
});

test("private open rejects another valid owner proof before constructing or sending a backend request", async (t) => {
  const f = await fixture(t);
  const wrongOwner = (f.ownerKey.startsWith("a") ? "b" : "a") + f.ownerKey.slice(1);
  const result = await f.relay.request({
    ...f.binding,
    request: {
      kind: "open",
      ownerKey: wrongOwner,
      url: `${f.origin}/v1/chat/completions`,
      body: '{"oldOwnerInput":"controlled"}',
    },
  });
  assert.deepEqual(result, { status: "denied", code: "enterprise_identity_changed" });
  assert.equal(f.requests.length, 0);
});
test("model stream handles cannot cross runtime or session and logout aborts a pending read", async (t) => {
  const f = await fixture(t);
  const open = await f.relay.request({
    ...f.binding,
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: '{"hold":true}',
    },
  });
  assert.ok(open.status === "ok" && open.streamId);
  assert.equal(
    (
      await f.relay.request({
        ...f.binding,
        runtime: {},
        request: { kind: "read", streamId: open.streamId },
      })
    ).status,
    "denied",
  );
  assert.equal(
    (
      await f.relay.request({
        ...f.binding,
        sessionId: "other",
        request: { kind: "close", streamId: open.streamId },
      })
    ).status,
    "denied",
  );
  const read = f.relay.request({
    ...f.binding,
    request: { kind: "read", streamId: open.streamId },
  });
  f.controller.abort();
  assert.equal((await read).status, "denied");
});
test("model relay rejects arbitrary targets before dispatch", async (t) => {
  const f = await fixture(t);
  for (const url of [
    `${f.origin}/v1/models`,
    `${f.origin}/v1/chat/completions?x=1`,
    "https://example.invalid/v1/chat/completions",
  ]) {
    assert.equal(
      (
        await f.relay.request({
          ...f.binding,
          request: { kind: "open", ownerKey: f.ownerKey, url, body: "{}" },
        })
      ).status,
      "denied",
    );
  }
  assert.equal(f.requests.length, 0);
});

test("relay preserves HTTP failures and rejects private tokens split across network chunks", async (t) => {
  const f = await fixture(t);
  for (const body of ['{"http-error":true}', '{"echo-private":true}']) {
    const open = await f.relay.request({
      ...f.binding,
      request: { kind: "open", ownerKey: f.ownerKey, url: `${f.origin}/v1/chat/completions`, body },
    });
    assert.ok(open.status === "ok" && open.streamId);
    const read = await f.relay.request({
      ...f.binding,
      request: { kind: "read", streamId: open.streamId },
    });
    if (body.includes("http-error")) {
      assert.equal(open.httpStatus, 403);
      assert.ok(read.status === "ok");
      assert.match(Buffer.from(read.chunk!, "base64").toString(), /FORBIDDEN/);
    } else {
      assert.equal(read.status, "denied");
      assert.ok(!JSON.stringify(read).includes(f.token));
    }
  }
});
test("relay enforces body/response bounds and only one pending read", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.relay.request({
        ...f.binding,
        request: {
          kind: "open",
          ownerKey: f.ownerKey,
          url: `${f.origin}/v1/chat/completions`,
          body: "x".repeat(1024 * 1024 + 1),
        },
      })
    ).status,
    "denied",
  );
  const open = await f.relay.request({
    ...f.binding,
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: '{"hold":true}',
    },
  });
  assert.ok(open.status === "ok" && open.streamId);
  await f.relay.request({ ...f.binding, request: { kind: "read", streamId: open.streamId } });
  const pending = f.relay.request({
    ...f.binding,
    request: { kind: "read", streamId: open.streamId },
  });
  assert.equal(
    (await f.relay.request({ ...f.binding, request: { kind: "read", streamId: open.streamId } }))
      .status,
    "denied",
  );
  f.relay.closeRuntime(f.binding.runtime);
  assert.equal((await pending).status, "denied");
  const large = await f.relay.request({
    ...f.binding,
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: '{"oversized-response":true}',
    },
  });
  assert.ok(large.status === "ok" && large.streamId);
  let failure = false;
  for (let i = 0; i < 160; i++) {
    const read = await f.relay.request({
      ...f.binding,
      request: { kind: "read", streamId: large.streamId },
    });
    if (read.status === "denied") {
      failure = true;
      break;
    }
    assert.ok(Buffer.from(read.chunk ?? "", "base64").length <= 65536);
  }
  assert.ok(failure);
});

test("late cancellation of an open receipt closes only its bound stream", async (t) => {
  const f = await fixture(t);
  const open = async (requestId: string) =>
    f.relay.request({
      ...f.binding,
      requestId,
      request: {
        kind: "open",
        ownerKey: f.ownerKey,
        url: `${f.origin}/v1/chat/completions`,
        body: '{"hold":true}',
      },
    });
  const first = await open("open-first"),
    second = await open("open-second");
  assert.ok(first.status === "ok" && first.streamId && second.status === "ok" && second.streamId);
  f.relay.cancelRequest({ ...f.binding, requestId: "open-first", sessionId: "forged" });
  const live = await f.relay.request({
    ...f.binding,
    request: { kind: "read", streamId: first.streamId },
  });
  assert.equal(live.status, "ok");
  f.relay.cancelRequest({ ...f.binding, requestId: "open-first" });
  assert.equal(
    (await f.relay.request({ ...f.binding, request: { kind: "read", streamId: first.streamId } }))
      .status,
    "denied",
  );
  assert.equal(
    (await f.relay.request({ ...f.binding, request: { kind: "read", streamId: second.streamId } }))
      .status,
    "ok",
  );
});

test("model streams expire at the absolute five-minute deadline", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = await f.relay.request({
    ...f.binding,
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: '{"hold":true}',
    },
  });
  assert.ok(opened.status === "ok" && opened.streamId);
  t.mock.timers.tick(300000);
  const read = await f.relay.request({
    ...f.binding,
    request: { kind: "read", streamId: opened.streamId },
  });
  assert.equal(read.status, "denied");
  t.mock.timers.reset();
});

test("cancel before headers uses the original open request and reclaims admission", async (t) => {
  const f = await fixture(t);
  const opening = f.relay.request({
    ...f.binding,
    requestId: "pending-open",
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: '{"beforeheaders":true}',
    },
  });
  await f.requestSeen;
  f.relay.cancelRequest({ ...f.binding, requestId: "pending-open" });
  assert.equal((await opening).status, "denied");
  const next = await f.relay.request({
    ...f.binding,
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: "{}",
    },
  });
  assert.equal(next.status, "ok");
});

test("Host transport rechecks identity after asynchronous proxy preparation", async (t) => {
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const network = createHostApiNetworkTransport(async () => {
    reached();
    await blocked;
    return {};
  });
  const f = await fixture(t, network.fetch);
  t.after(async () => {
    release();
    await network.disposeAndWait();
  });
  const opening = f.relay.request({
    ...f.binding,
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: "{}",
    },
  });
  await entered;
  f.controller.abort();
  release();
  assert.equal((await opening).status, "denied");
  assert.equal(f.requests.length, 0);
});

test("the real bridge reclaims open receipts cancelled after the RPC has completed", async (t) => {
  const f = await fixture(t),
    closed = new Emitter<void>();
  const responses: { status: string; streamId?: string; code?: string }[] = [];
  const client = {
    isDisposed: false,
    onClose: closed.event,
    respond: async (_id: string | number, result: unknown) => {
      responses.push(result as (typeof responses)[number]);
    },
    respondError: async () => {
      throw new Error("unexpected protocol failure");
    },
  };
  const workspace = {
    workspaceKey: "bridge",
    workspacePath: "/controlled",
    workspaceIdentity: "identity",
  };
  const bridge = createEnterpriseToolAuthorizationBridge({
    models: f.relay,
    isCurrent: () => true,
  });
  await bridge.handleModel(client, workspace, 1, {
    workspace,
    requestId: "open-receipt",
    sessionId: "conversation",
    request: {
      kind: "open",
      ownerKey: f.ownerKey,
      url: `${f.origin}/v1/chat/completions`,
      body: '{"hold":true}',
    },
  });
  assert.ok(responses[0]?.status === "ok" && responses[0].streamId);
  bridge.cancel(client, workspace, {
    workspace,
    requestId: "open-receipt",
    sessionId: "conversation",
  });
  await bridge.handleModel(client, workspace, 2, {
    workspace,
    requestId: "after-cancel",
    sessionId: "conversation",
    request: { kind: "read", streamId: responses[0].streamId },
  });
  assert.equal(responses[1]?.status, "denied");
  closed.dispose();
});

test("nested tool arguments cannot leak Unicode-escaped tokens across delta boundaries", async (t) => {
  const f = await fixture(t);
  for (const variant of ["echo-tools", "echo-tools-fragmented"]) {
    const open = await f.relay.request({
      ...f.binding,
      request: {
        kind: "open",
        ownerKey: f.ownerKey,
        url: `${f.origin}/v1/chat/completions`,
        body: JSON.stringify({ [variant]: true }),
      },
    });
    assert.ok(open.status === "ok" && open.streamId);
    const result = await f.relay.request({
      ...f.binding,
      request: { kind: "read", streamId: open.streamId },
    });
    assert.equal(result.status, "denied");
    assert.ok(!("chunk" in result));
  }
});
