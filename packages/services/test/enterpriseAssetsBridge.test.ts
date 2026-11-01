import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "@zcode/rpc";
import { createEnterpriseToolAuthorizationBridge } from "../src/zcode-agent/enterpriseToolAuthorizationBridge.js";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import type { ZCodeProtocolTransportClosedEvent } from "../src/zcode-agent/zcodeProtocolTransport.js";

const workspace = {
  workspaceKey: "controlled",
  workspaceIdentity: "controlled",
  workspacePath: "/controlled",
};
const request = { requestId: "enterprise-assets:1", sessionId: "controlled", workspace };
function peer() {
  const closed = new Emitter<void>(),
    results: unknown[] = [],
    errors: unknown[] = [];
  return {
    isDisposed: false,
    onClose: closed.event,
    close: () => closed.fire(),
    results,
    errors,
    respond: async (_id: string | number, value: unknown) => {
      results.push(value);
    },
    respondError: async (_id: string | number, value: unknown) => {
      errors.push(value);
    },
  };
}

test("tool admission and catalogs share one bounded pending owner", async () => {
  const client = peer();
  let calls = 0,
    started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    resolver: {
      async authorize() {
        throw new Error("A full catalog owner must reject before execution admission");
      },
    },
    assets: {
      async readCatalog() {
        if (++calls === 32) started();
        return new Promise<never>(() => {});
      },
    },
  });
  const requests = Array.from({ length: 32 }, (_, index) => ({
    ...request,
    requestId: `enterprise-assets:${index}`,
  }));
  const work = requests.map((value, index) =>
    bridge.handleCatalog(client, workspace, index, value, "controlled-trace"),
  );
  await entered;
  await bridge.handle(
    client,
    workspace,
    40,
    {
      ...request,
      requestId: "enterprise-tool:full",
      toolCallId: "controlled",
      toolName: "Read",
      workingDirectory: "/controlled",
      phase: "before_dispatch",
      capability: {
        permission: "read",
        sideEffectScope: "none",
        readOnly: true,
        destructive: false,
      },
      input: {},
    },
    "controlled-trace",
  );
  assert.deepEqual(client.results, [{ allowed: false, code: "enterprise_policy_unavailable" }]);
  for (const value of requests) bridge.cancel(client, workspace, value);
  await Promise.all(work);
  assert.equal(client.results.length, 33);
  assert.equal(calls, 32);
});

test("catalog reverse RPC rejects forged workspaces, missing traces and unavailable ownership", async () => {
  const client = peer();
  let calls = 0;
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    assets: {
      async readCatalog() {
        calls++;
        return { status: "unmanaged" as const };
      },
    },
  });
  await bridge.handleCatalog(
    client,
    workspace,
    1,
    { ...request, workspace: { ...workspace, workspaceKey: "forged" } },
    "controlled-trace",
  );
  await bridge.handleCatalog(client, workspace, 2, request);
  assert.deepEqual(client.results, [
    { status: "denied", code: "enterprise_workspace_mismatch" },
    { status: "denied", code: "enterprise_trace_required" },
  ]);
  assert.equal(calls, 0);
  const absent = createEnterpriseToolAuthorizationBridge({ isCurrent: () => true });
  await absent.handleCatalog(client, workspace, 3, request, "controlled-trace");
  assert.deepEqual(client.results[2], { status: "denied", code: "enterprise_policy_unavailable" });
});

test("catalog work shares connection/session cancellation and cannot return a late ready result", async () => {
  const client = peer(),
    stranger = peer();
  let started!: () => void, signal!: AbortSignal;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    assets: {
      async readCatalog(traceId, abort) {
        assert.equal(traceId, "controlled-trace");
        signal = abort!;
        started();
        return new Promise<never>(() => {});
      },
    },
  });
  const work = bridge.handleCatalog(client, workspace, 1, request, "controlled-trace");
  await entered;
  bridge.cancel(stranger, workspace, request);
  bridge.cancel(client, workspace, { ...request, sessionId: "other" });
  assert.equal(signal.aborted, false);
  bridge.cancel(client, workspace, request);
  await work;
  assert.equal(signal.aborted, true);
  assert.deepEqual(client.results, [
    { status: "denied", code: "enterprise_authorization_cancelled" },
  ]);
});

test("catalog response validation, obsolete clients and bounded deadlines fail closed", async () => {
  for (const mode of ["invalid", "obsolete", "deadline", "closed"] as const) {
    const client = peer();
    let current = true;
    const bridge = createEnterpriseToolAuthorizationBridge({
      isCurrent: () => current,
      catalogTimeoutMs: 10,
      assets: {
        async readCatalog() {
          if (mode === "invalid")
            return {
              status: "ready",
              ownerKey: "c".repeat(64),
              allowFilesystem: true,
              personalSkills: false,
              dangerousSkills: false,
              assets: [],
              experts: [],
              connectors: [],
              unexpected: "private",
            };
          if (mode === "obsolete") {
            current = false;
            return { status: "unmanaged" as const };
          }
          if (mode === "closed") client.close();
          return new Promise<never>(() => {});
        },
      },
    });
    await bridge.handleCatalog(client, workspace, 1, request, "controlled-trace");
    const result = client.results[0] as { status: string; code: string };
    assert.equal(result.status, "denied");
    assert.equal(
      result.code,
      mode === "obsolete"
        ? "enterprise_runtime_obsolete"
        : mode === "invalid"
          ? "enterprise_policy_unavailable"
          : "enterprise_authorization_cancelled",
    );
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("real protocol-client disposal immediately aborts reverse RPC before transport shutdown", async (t) => {
  for (const mode of ["sync", "async", "transport-first"] as const) {
    const messages = new Emitter<ZCodeProtocolMessage>(),
      closed = new Emitter<ZCodeProtocolTransportClosedEvent>();
    const client = new ZCodeProtocolClient({
      kind: "memory",
      onMessage: messages.event,
      onClose: closed.event,
      send: async () => {},
      dispose: () => closed.fire({}),
      disposeAndWait: async () => closed.fire({}),
    });
    let count = 0,
      started!: () => void,
      signal!: AbortSignal;
    client.onClose(() => {
      count++;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const bridge = createEnterpriseToolAuthorizationBridge({
      isCurrent: () => true,
      assets: {
        async readCatalog(_trace, abort) {
          signal = abort!;
          started();
          return new Promise<never>(() => {});
        },
      },
    });
    const work = bridge
      .handleCatalog(client, workspace, 1, request, "controlled-trace")
      .catch(() => {});
    t.after(async () => {
      bridge.cancel(client, workspace, request);
      await work;
      client.dispose();
      messages.dispose();
      closed.dispose();
    });
    await entered;
    if (mode === "transport-first") closed.fire({});
    const disposing = mode === "async" ? client.disposeAndWait() : client.dispose();
    assert.equal(
      signal.aborted,
      true,
      "connection cancellation must happen synchronously at disposal",
    );
    await disposing;
    await work;
    assert.equal(
      count,
      mode === "transport-first" ? 1 : 0,
      "explicit disposal does not synthesize transport closure",
    );
  }
});

test("throwing close observers do not prevent explicit connection disposal or reverse-RPC cancellation", async (t) => {
  for (const asynchronous of [false, true]) {
    const messages = new Emitter<ZCodeProtocolMessage>(),
      closed = new Emitter<ZCodeProtocolTransportClosedEvent>();
    let disposals = 0,
      signal!: AbortSignal,
      started!: () => void;
    const shutdown = () => {
      disposals++;
      closed.fire({});
    };
    const client = new ZCodeProtocolClient({
      kind: "memory",
      onMessage: messages.event,
      onClose: closed.event,
      send: async () => {},
      dispose: shutdown,
      disposeAndWait: async () => shutdown(),
    });
    client.onClose(() => {
      throw new Error("Controlled observer failure");
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const bridge = createEnterpriseToolAuthorizationBridge({
      isCurrent: () => true,
      assets: {
        async readCatalog(_trace, abort) {
          signal = abort!;
          started();
          return new Promise<never>(() => {});
        },
      },
    });
    const work = bridge
      .handleCatalog(client, workspace, 1, request, "controlled-trace")
      .catch(() => {});
    t.after(async () => {
      bridge.cancel(client, workspace, request);
      await work;
      messages.dispose();
      closed.dispose();
    });
    await entered;
    if (asynchronous) await assert.doesNotReject(() => client.disposeAndWait());
    else assert.doesNotThrow(() => client.dispose());
    assert.equal(signal.aborted, true);
    assert.equal(disposals, 1);
    client.dispose();
    assert.equal(disposals, 1);
    await work;
  }
});

function connectorRequest(overrides: Record<string, unknown> = {}) {
  return {
    ...request,
    requestId: "enterprise-connector:1",
    connector: {
      asset: {
        id: "controlled-connector",
        kind: "connector",
        version: 1,
        checksum: "c".repeat(64),
      },
      name: "Controlled Connector",
      distributed: true,
    },
    ownerKey: "a".repeat(64),
    request: { kind: "rpc", frame: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
    ...overrides,
  };
}

test("the connector channel forwards frames and refuses without a relay or trace", async () => {
  const client = peer();
  const forwarded: unknown[] = [];
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    connectors: {
      async request(input) {
        forwarded.push(input.frame);
        return {
          status: "ok",
          frame: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
          mcpSessionId: "session-1",
        };
      },
      async release() {
        forwarded.push("release");
        return { status: "ok" };
      },
    },
  });
  await bridge.handleConnector(client, workspace, 1, connectorRequest(), "controlled-trace");
  assert.deepEqual(client.results.at(-1), {
    status: "ok",
    frame: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    mcpSessionId: "session-1",
  });
  // 缺少 trace 或 workspace 不符都拒绝，且不外发任何帧。
  const before = forwarded.length;
  await bridge.handleConnector(client, workspace, 2, connectorRequest(), undefined);
  assert.deepEqual(client.results.at(-1), {
    status: "denied",
    code: "enterprise_trace_required",
  });
  await bridge.handleConnector(
    client,
    { ...workspace, workspaceKey: "foreign" },
    3,
    connectorRequest(),
    "controlled-trace",
  );
  assert.deepEqual(client.results.at(-1), {
    status: "denied",
    code: "enterprise_workspace_mismatch",
  });
  assert.equal(forwarded.length, before);

  // 未装配 relay 时整个连接器通道 fail closed。
  const withoutRelay = createEnterpriseToolAuthorizationBridge({ isCurrent: () => true });
  await withoutRelay.handleConnector(client, workspace, 4, connectorRequest(), "controlled-trace");
  assert.deepEqual(client.results.at(-1), {
    status: "denied",
    code: "enterprise_policy_unavailable",
  });

  // 显式回收使用同一条通道与同一份 workspace/trace 校验。
  await bridge.handleConnector(
    client,
    workspace,
    5,
    connectorRequest({ request: { kind: "release", mcpSessionId: "session-1" } }),
    "controlled-trace",
  );
  assert.deepEqual(client.results.at(-1), { status: "ok" });
  assert.equal(forwarded.at(-1), "release");
});

test("closing the connection cancels a pending connector frame without a late result", async () => {
  const client = peer();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    connectors: {
      async request(input) {
        entered();
        await new Promise<void>((resolve) =>
          input.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        throw new Error("cancelled");
      },
      async release() {
        return { status: "ok" };
      },
    },
  });
  const work = bridge
    .handleConnector(client, workspace, 1, connectorRequest(), "controlled-trace")
    .catch(() => {});
  await started;
  bridge.cancel(client, workspace, {
    requestId: "enterprise-connector:1",
    sessionId: "controlled",
    workspace,
  });
  await work;
  assert.equal(aborted, true);
  assert.deepEqual(client.results.at(-1), {
    status: "denied",
    code: "enterprise_authorization_cancelled",
  });
});
