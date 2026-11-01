import { test } from "node:test";
import assert from "node:assert/strict";
import { createRootTraceContext, type ExecutionPort } from "@zcode/contracts";
import { withEnterpriseExecutionAuthorization } from "@zcode/adapters/exec";

test("native execution admission stops foreground and background hooks or scripts before starting a process", async () => {
  let runs = 0,
    starts = 0,
    authorizations = 0;
  const raw: ExecutionPort = {
    async run() {
      runs++;
      throw new Error("must not run");
    },
    async start() {
      starts++;
      throw new Error("must not start");
    },
  };
  const port = withEnterpriseExecutionAuthorization(raw, {
    authorization: {
      async authorize(request) {
        authorizations++;
        assert.equal(request.phase, "native_execution");
        assert.equal(request.capability.permission, "bash");
        assert.ok(request.traceContext.traceId);
        assert.ok(!JSON.stringify(request).includes("synthetic-secret"));
        return { allowed: false, code: "enterprise_shell_denied" };
      },
    },
    sessionId: "controlled-session",
    workspacePath: "/controlled",
    workingDirectory: "/controlled",
    traceContext: createRootTraceContext(),
  });
  const request = {
    command: { mode: "shell" as const, command: "echo controlled" },
    env: { set: { SECRET: "synthetic-secret" } },
  };
  await assert.rejects(() => port.run(request), /enterprise_shell_denied/);
  await assert.rejects(() => port.start!(request), /enterprise_shell_denied/);
  assert.deepEqual({ runs, starts, authorizations }, { runs: 0, starts: 0, authorizations: 2 });
});

test("native authorization captures cwd for the same request consumed by the execution adapter", async () => {
  let authorized = "",
    dispatched = "";
  const port = withEnterpriseExecutionAuthorization(
    {
      async run(request) {
        dispatched = request.cwd!;
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "done", bytes: 4, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 0,
          timedOut: false,
          cancelled: false,
          startedAt: new Date(),
          completedAt: new Date(),
        };
      },
    },
    {
      authorization: {
        async authorize(request) {
          authorized = request.workingDirectory;
          return { allowed: true, code: "allowed" };
        },
      },
      sessionId: "controlled-session",
      workspacePath: "/controlled",
      workingDirectory: "/controlled",
      traceContext: createRootTraceContext(),
    },
  );
  const result = await port.run({ command: { mode: "argv", file: "controlled-executable" } });
  assert.equal(result.status, "completed");
  assert.equal(authorized, "/controlled");
  assert.equal(dispatched, authorized);
});

test("native admission combines the execution signal with the parent execution-context cancellation", async () => {
  let runs = 0;
  const parent = new AbortController(),
    direct = new AbortController();
  const port = withEnterpriseExecutionAuthorization(
    {
      async run() {
        runs++;
        throw new Error("must not run");
      },
    },
    {
      authorization: {
        async authorize() {
          parent.abort();
          return { allowed: true, code: "allowed" };
        },
      },
      sessionId: "controlled-session",
      workspacePath: "/controlled",
      workingDirectory: "/controlled",
      traceContext: createRootTraceContext(),
    },
  );
  await assert.rejects(() =>
    port.run(
      { command: { mode: "shell", command: "controlled" } },
      {
        signal: direct.signal,
        context: {
          abortSignal: parent.signal,
          trace: createRootTraceContext(),
          logger: {
            debug() {},
            info() {},
            warn() {},
            error() {},
            child() {
              return this;
            },
          },
        },
      },
    ),
  );
  assert.equal(runs, 0);
});
