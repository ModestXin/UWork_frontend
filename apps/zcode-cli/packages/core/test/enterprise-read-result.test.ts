import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  HookEventName,
  SessionEventType,
  type EnterpriseToolAuthorizationDecision,
  type EnterpriseToolAuthorizationPort,
  type EnterpriseToolAuthorizationRequest,
  type FileSystemPort,
  type FileSystemReadTextRangeResult,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { readToolEntry } from "../src/tool/handlers/read.js";

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
const PATH = "/controlled/read-result.txt";
const MARKER = "CONTROLLED_READ_RESULT_BODY";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(options: { standalone?: boolean; unmanaged?: boolean; timeoutMs?: number } = {}) {
  let decision: EnterpriseToolAuthorizationDecision = options.unmanaged
    ? { allowed: true, code: "not_managed" }
    : { allowed: true, code: "allowed", ownerKey: OWNER_A };
  let releaseFailure = false;
  let postHooks = 0;
  let reads = 0;
  let holdAuthorization = false;
  const requests: EnterpriseToolAuthorizationRequest[] = [];
  const events: SessionEvent[] = [];
  const entered = deferred<void>();
  const bytes = deferred<FileSystemReadTextRangeResult>();
  const releaseEntered = deferred<void>();
  const releaseDecision = deferred<EnterpriseToolAuthorizationDecision>();
  const controller = new AbortController();
  const unexpectedFileOperation = async (): Promise<never> => {
    throw Error("Unexpected filesystem operation");
  };
  const port: EnterpriseToolAuthorizationPort = {
    async authorize(request) {
      requests.push(request);
      if (request.phase === "before_result" && holdAuthorization) {
        releaseEntered.resolve();
        return releaseDecision.promise; // Deliberately ignores AbortSignal.
      }
      if (request.phase === "before_result" && releaseFailure)
        throw Error("private authority detail");
      return { ...decision };
    },
  };
  let currentPort = options.standalone ? undefined : port;
  const permissions = new PermissionService(defaultPermissionConfig, currentPort);
  Object.defineProperty(permissions, "enterpriseAuthorization", { get: () => currentPort });
  const registry = createToolRegistry();
  registry.register(
    options.timeoutMs === undefined
      ? readToolEntry
      : {
          ...readToolEntry,
          timeout: {
            defaultMs: options.timeoutMs,
            maxMs: options.timeoutMs,
            allowCallOverride: false,
          },
        },
  );
  const executor = createToolExecutor({
    registry,
    permissionService: permissions,
    mode: "yolo",
    sessionId: "read-result-session" as SessionId,
    workingDirectory: "/controlled",
    workspaceRoot: "/controlled",
    workspaceIdentity: "controlled",
    fileSystemPort: {
      createDirectory: unexpectedFileOperation,
      readTextFile: unexpectedFileOperation,
      readBinaryFile: unexpectedFileOperation,
      writeTextFile: unexpectedFileOperation,
      removeFile: unexpectedFileOperation,
      listDirectory: unexpectedFileOperation,
      searchFiles: unexpectedFileOperation,
      searchText: unexpectedFileOperation,
      async stat() {
        return { path: PATH, kind: "file", sizeBytes: MARKER.length, mtimeMs: 1 };
      },
      async readTextFileRange() {
        reads++;
        entered.resolve();
        return bytes.promise;
      },
    } satisfies FileSystemPort,
    hookRunner: {
      async run(input) {
        if (input.hookEventName === HookEventName.PostToolUse) postHooks++;
        return { additionalContexts: [] };
      },
    },
    emitEvent: async (event) => {
      events.push(event);
    },
  });
  const release = () =>
    bytes.resolve({
      path: PATH,
      content: MARKER,
      encoding: "utf8",
      bytesRead: MARKER.length,
      sizeBytes: MARKER.length,
      truncated: false,
      startLine: 1,
      lineCount: 1,
      totalLines: 1,
    });
  return {
    requests,
    events,
    entered,
    release,
    controller,
    releaseEntered,
    run: () =>
      executor.execute(
        { id: "read-result-call", name: "Read", input: { file_path: PATH } },
        { signal: controller.signal },
      ),
    decide: (value: EnterpriseToolAuthorizationDecision) => {
      decision = value;
    },
    removePort: () => {
      currentPort = undefined;
    },
    replacePort: () => {
      currentPort = {
        authorize: async () => ({ allowed: true, code: "allowed", ownerKey: OWNER_B }),
      };
    },
    failRelease: () => {
      releaseFailure = true;
    },
    holdRelease: () => {
      holdAuthorization = true;
    },
    finishAuthorization: () =>
      releaseDecision.resolve({ allowed: true, code: "allowed", ownerKey: OWNER_A }),
    failRead: () => bytes.reject(Error("controlled filesystem failure")),
    counts: () => ({ reads, postHooks }),
  };
}

async function waiting(f: ReturnType<typeof fixture>) {
  const pending = f.run();
  await Promise.race([
    f.entered.promise,
    pending.then(() => assert.fail("Read never entered its filesystem port")),
  ]);
  return { pending };
}

function withheld(
  f: ReturnType<typeof fixture>,
  result: Awaited<ReturnType<ReturnType<typeof fixture>["run"]>>,
) {
  assert.equal(result.success, false);
  assert.equal(JSON.stringify(result).includes(MARKER), false);
  assert.equal(JSON.stringify(f.events).includes(MARKER), false);
  assert.equal(
    f.events.some((event) => event.type === SessionEventType.ToolCallResult),
    false,
  );
  assert.deepEqual(f.counts(), { reads: 1, postHooks: 0 });
  assert.match(result.error?.message ?? "", /Read completed; content withheld/);
}

test("builtin Read releases current same-owner bytes and carries its original owner to before_result", async () => {
  const f = fixture();
  const { pending } = await waiting(f);
  f.release();
  const result = await pending;
  assert.equal(result.success, true);
  assert.match(String(result.modelContent), new RegExp(MARKER));
  assert.equal(f.counts().postHooks, 1);
  assert.deepEqual(
    f.requests.map((request) => [request.phase, request.ownerKey]),
    [
      ["before_hooks", undefined],
      ["before_dispatch", undefined],
      ["before_result", OWNER_A],
    ],
  );
});

test("pending Read revocation withholds bytes before PostToolUse, successful events or model serialization", async () => {
  const f = fixture();
  const { pending } = await waiting(f);
  f.decide({ allowed: false, code: "enterprise_filesystem_denied" });
  f.release();
  withheld(f, await pending);
});

test("another valid owner and either managed-mode transition cannot release a pending Read", async () => {
  for (const change of ["owner", "to-unmanaged", "to-managed"] as const) {
    const f = fixture({ unmanaged: change === "to-managed" });
    const { pending } = await waiting(f);
    f.decide(
      change === "to-unmanaged"
        ? { allowed: true, code: "not_managed" }
        : { allowed: true, code: "allowed", ownerKey: OWNER_B },
    );
    f.release();
    withheld(f, await pending);
  }
});

test("removal or replacement of the original authorization port cannot release pending bytes", async () => {
  for (const remove of [true, false]) {
    const f = fixture();
    const { pending } = await waiting(f);
    if (remove) f.removePort();
    else f.replacePort();
    f.release();
    withheld(f, await pending);
  }
});

test("managed Read without an owner binding fails before the handler; missing return owner also withholds", async () => {
  const f = fixture();
  f.decide({ allowed: true, code: "allowed" });
  f.release();
  assert.equal((await f.run()).success, false);
  assert.deepEqual(f.counts(), { reads: 0, postHooks: 0 });
  const g = fixture();
  const { pending } = await waiting(g);
  g.decide({ allowed: true, code: "allowed" });
  g.release();
  withheld(g, await pending);
});

test("failed result authorization does not release bytes or raw authority errors", async () => {
  const f = fixture();
  const { pending } = await waiting(f);
  f.failRelease();
  f.release();
  const result = await pending;
  withheld(f, result);
  assert.equal(JSON.stringify(result).includes("private authority detail"), false);
});

test("cancellation while Read waits and filesystem failure never become successful content", async () => {
  const f = fixture();
  const { pending } = await waiting(f);
  f.controller.abort();
  f.release();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(JSON.stringify(f.events).includes(MARKER), false);
  assert.equal(f.counts().postHooks, 0);
  const g = fixture();
  const other = await waiting(g);
  g.failRead();
  assert.equal((await other.pending).success, false);
  assert.equal(
    g.requests.some((request) => request.phase === "before_result"),
    false,
  );
  assert.equal(g.counts().postHooks, 0);
});

test("standalone and explicitly unmanaged Read keep their existing positive behavior", async () => {
  for (const standalone of [true, false]) {
    const f = fixture({ standalone, unmanaged: !standalone });
    const { pending } = await waiting(f);
    f.release();
    const result = await pending;
    assert.equal(result.success, true);
    assert.match(String(result.modelContent), new RegExp(MARKER));
  }
});

for (const cancellation of [true, false]) {
  test(
    `uncooperative Read result authority is bounded by ${cancellation ? "cancellation" : "the original deadline"}`,
    { timeout: 1500 },
    async (t) => {
      const f = fixture({ timeoutMs: cancellation ? 1000 : 30 });
      t.after(f.finishAuthorization);
      f.holdRelease();
      const { pending } = await waiting(f);
      f.release();
      await f.releaseEntered.promise;
      if (cancellation) f.controller.abort();
      const result = await pending;
      withheld(f, result);
      assert.equal(result.error?.type, cancellation ? "tool_cancelled" : "tool_timeout");
      const terminals = f.events.filter(
        (event) => event.type === SessionEventType.ToolCallError,
      ).length;
      assert.equal(terminals, 1);
      f.finishAuthorization();
      await setImmediate();
      assert.equal(
        f.events.filter((event) => event.type === SessionEventType.ToolCallError).length,
        terminals,
      );
    },
  );
}
