import { test } from "node:test";
import assert from "node:assert/strict";
import { Emitter } from "@zcode/rpc";
import { createEnterpriseToolAuthorizationBridge } from "../src/zcode-agent/enterpriseToolAuthorizationBridge.js";
import type {
  ZCodeEnterpriseToolAuthorizationParams,
  ZCodeEnterpriseToolAuthorizationResult,
} from "@zcode/shared";
import { zcodeEnterpriseToolAuthorizationParamsSchema } from "@zcode/shared";

const workspace = {
  workspaceKey: "controlled-identity",
  workspaceIdentity: "controlled-identity",
  workspacePath: "/controlled",
};
const request: ZCodeEnterpriseToolAuthorizationParams = {
  workspace,
  requestId: "request-1",
  sessionId: "session-1",
  toolCallId: "call-1",
  toolName: "Read",
  workingDirectory: "/controlled",
  input: { file_path: "/controlled/file.txt" },
  phase: "before_dispatch",
  capability: { permission: "read", sideEffectScope: "none", readOnly: true, destructive: false },
};
function client() {
  const closed = new Emitter<void>(),
    results: unknown[] = [],
    errors: unknown[] = [];
  return {
    isDisposed: false,
    onClose: closed.event,
    close: () => closed.fire(),
    results,
    errors,
    respond: async (_id: string | number, result: unknown) => {
      results.push(result);
    },
    respondError: async (_id: string | number, error: unknown) => {
      errors.push(error);
    },
  };
}

test("before_result is a strict builtin Read request and keeps owner fencing on the existing bridge", async () => {
  const release = { ...request, phase: "before_result", ownerKey: "a".repeat(64) };
  assert.equal(zcodeEnterpriseToolAuthorizationParamsSchema.safeParse(release).success, true);
  assert.equal(
    zcodeEnterpriseToolAuthorizationParamsSchema.safeParse({ ...release, ownerKey: undefined })
      .success,
    true,
  );
  for (const patch of [
    { toolName: "Write" },
    { ownerKey: "not-an-owner" },
    { asset: {} },
    { capability: { ...request.capability, permission: "mcp" } },
    { capability: { ...request.capability, readOnly: false } },
    { capability: { ...request.capability, destructive: true } },
    { capability: { ...request.capability, sideEffectScope: "workspace" } },
  ])
    assert.equal(
      zcodeEnterpriseToolAuthorizationParamsSchema.safeParse({ ...release, ...patch }).success,
      false,
    );
  assert.equal(
    zcodeEnterpriseToolAuthorizationParamsSchema.safeParse({ ...release, phase: "before_dispatch" })
      .success,
    false,
  );
  const peer = client();
  let seen: ZCodeEnterpriseToolAuthorizationParams | undefined;
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    resolver: {
      async authorize(value) {
        seen = value;
        return { allowed: true, code: "allowed", ownerKey: release.ownerKey };
      },
    },
  });
  await bridge.handle(peer, workspace, 1, release);
  assert.equal(seen?.ownerKey, release.ownerKey);
  assert.deepEqual(peer.results, [{ allowed: true, code: "allowed", ownerKey: release.ownerKey }]);
});

test("the enterprise reverse RPC rejects forged workspace routing before calling the resolver", async () => {
  const peer = client();
  let calls = 0;
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    resolver: {
      async authorize() {
        calls++;
        return { allowed: true, code: "allowed" };
      },
    },
  });
  await bridge.handle(peer, workspace, 1, {
    ...request,
    workspace: { ...workspace, workspaceIdentity: "other", workspaceKey: "other" },
  });
  assert.deepEqual(peer.results, [{ allowed: false, code: "enterprise_workspace_mismatch" }]);
  assert.equal(calls, 0);
});

test("a symlinked workspace path is the same workspace, while a real mismatch still fails closed", async () => {
  // macOS 的 /tmp 是指向 /private/tmp 的符号链接：子进程 realpath 后上报规范路径，
  // Host 注册的是原始路径，二者必须是同一个工作区。
  const { mkdtemp, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "uwork-workspace-link-"));
  const target = join(directory, "workspace");
  const link = join(directory, "linked-workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(target, { recursive: true });
  await symlink(target, link);
  try {
    const registered = { workspaceKey: target, workspacePath: target };
    let calls = 0;
    const bridge = createEnterpriseToolAuthorizationBridge({
      isCurrent: () => true,
      resolver: {
        async authorize() {
          calls++;
          return { allowed: true, code: "allowed" };
        },
      },
    });
    const peer = client();
    await bridge.handle(peer, registered, 1, {
      ...request,
      workspace: { workspaceKey: link, workspacePath: link },
    });
    assert.deepEqual(peer.results, [{ allowed: true, code: "allowed" }]);
    assert.equal(calls, 1);
    // 带独立 workspaceIdentity 的引用不参与规范路径比较：伪造身份仍然拒绝。
    const forged = client();
    await bridge.handle(forged, registered, 2, {
      ...request,
      workspace: { workspaceKey: "other", workspacePath: target, workspaceIdentity: "other" },
    });
    assert.deepEqual(forged.results, [{ allowed: false, code: "enterprise_workspace_mismatch" }]);
    // 完全不同目录仍然不是同一个工作区。
    const other = client();
    await bridge.handle(other, registered, 3, {
      ...request,
      workspace: { workspaceKey: directory, workspacePath: directory },
    });
    assert.deepEqual(other.results, [{ allowed: false, code: "enterprise_workspace_mismatch" }]);
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("attachment owner proof uses the original bridge and rejects a different workspace before resolution", async () => {
  let calls = 0;
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    resolver: {
      async authorize(value) {
        calls++;
        assert.equal(value.toolName, "PromptAttachmentRead");
        assert.equal(value.ownerKey, "a".repeat(64));
        return { allowed: true, code: "allowed", ownerKey: value.ownerKey };
      },
    },
  });
  const release = {
    ...request,
    toolName: "PromptAttachmentRead",
    input: { path: "/controlled/owned.txt", kind: "file" },
    phase: "before_result" as const,
    ownerKey: "a".repeat(64),
    capability: {
      permission: "filesystem",
      sideEffectScope: "none" as const,
      readOnly: true,
      destructive: false,
    },
  };
  const accepted = client();
  await bridge.handle(accepted, workspace, 1, release);
  assert.deepEqual(accepted.results, [
    { allowed: true, code: "allowed", ownerKey: release.ownerKey },
  ]);
  const forged = client();
  await bridge.handle(forged, workspace, 2, {
    ...release,
    workspace: { ...workspace, workspaceIdentity: "other", workspaceKey: "other" },
  });
  assert.deepEqual(forged.results, [{ allowed: false, code: "enterprise_workspace_mismatch" }]);
  assert.equal(calls, 1);
});

test("obsolete CLI clients cannot return a late successful enterprise authorization", async () => {
  const peer = client();
  let current = true;
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => current,
    resolver: {
      async authorize() {
        current = false;
        return { allowed: true, code: "allowed" };
      },
    },
  });
  await bridge.handle(peer, workspace, 1, request);
  assert.deepEqual(peer.results, [{ allowed: false, code: "enterprise_runtime_obsolete" }]);
});

test("cancellation is bound to the same connection, workspace and session and aborts Host work", async () => {
  const peer = client(),
    stranger = client();
  let started!: () => void, signal!: AbortSignal;
  const entered = new Promise<void>((resolve) => (started = resolve));
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    resolver: {
      async authorize(_request, value) {
        signal = value!;
        started();
        return new Promise<ZCodeEnterpriseToolAuthorizationResult>(() => {});
      },
    },
  });
  const work = bridge.handle(peer, workspace, 1, request);
  await entered;
  const cancellation = { workspace, requestId: request.requestId, sessionId: request.sessionId };
  bridge.cancel(stranger, workspace, cancellation);
  bridge.cancel(peer, workspace, { ...cancellation, sessionId: "other" });
  assert.equal(signal.aborted, false);
  bridge.cancel(peer, workspace, cancellation);
  await work;
  assert.equal(signal.aborted, true);
  assert.deepEqual(peer.results, [{ allowed: false, code: "enterprise_authorization_cancelled" }]);
});

test("connection closure aborts pending enterprise authorization without waiting for backend cooperation", async () => {
  const peer = client();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    resolver: {
      async authorize() {
        started();
        return new Promise(() => {});
      },
    },
  });
  const work = bridge.handle(peer, workspace, 1, request);
  await entered;
  peer.close();
  await work;
  assert.deepEqual(peer.results, [{ allowed: false, code: "enterprise_authorization_cancelled" }]);
});

test("a bounded Host deadline rejects an uncooperative resolver", async () => {
  const peer = client();
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    timeoutMs: 20,
    resolver: {
      async authorize() {
        return new Promise(() => {});
      },
    },
  });
  await bridge.handle(peer, workspace, 1, request);
  assert.deepEqual(peer.results, [{ allowed: false, code: "enterprise_authorization_cancelled" }]);
});

test("oversized input and invalid resolver responses cannot be upgraded into authorization", async () => {
  const peer = client();
  let calls = 0;
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    resolver: {
      async authorize() {
        calls++;
        return { allowed: true, code: "enterprise_denied" };
      },
    },
  });
  await bridge.handle(peer, workspace, 1, { ...request, input: { value: "x".repeat(262145) } });
  assert.equal(peer.errors.length, 1);
  assert.equal(calls, 0);
  await bridge.handle(peer, workspace, 2, request);
  assert.deepEqual(peer.results, [{ allowed: false, code: "enterprise_policy_unavailable" }]);
});
