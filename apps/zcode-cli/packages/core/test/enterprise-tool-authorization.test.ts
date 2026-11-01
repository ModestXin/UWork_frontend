import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SessionEventType,
  type SessionEvent,
  type SessionId,
  type CollaborationMode,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";
import type { HookRunner } from "../src/hooks/types.js";

function setup(input: {
  authorize: (
    request: { input: unknown; phase: string },
    signal?: AbortSignal,
  ) => Promise<{ allowed: boolean; code: string }>;
  mode?: CollaborationMode;
  hookRunner?: HookRunner;
  modifyByApproval?: unknown;
  resolveInput?: ToolEntry["resolveInput"];
}) {
  let executions = 0,
    approvals = 0;
  let observedInput: unknown;
  const events: SessionEvent[] = [];
  const registry = createToolRegistry();
  const entry: ToolEntry = {
    capability: "fixture.shell",
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
    metadata: {
      name: "Bash",
      readOnly: false,
      destructive: false,
      concurrentSafe: false,
      sideEffectScope: "workspace",
      riskLevel: "medium",
      needsApproval: true,
    },
    permission: {
      permission: "bash",
      reason: "Execute shell",
      riskLevel: "medium",
      sideEffectScope: "workspace",
      needsApproval: true,
      patternSources: [],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 1024, maxModelBytes: 1024, strategy: "truncate" },
    timeout: { defaultMs: 1000, allowCallOverride: false },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: "Cancelled" },
    trace: { required: true, propagateToAdapters: true, recordInput: "none", recordOutput: "none" },
    handler: async (value) => {
      executions++;
      observedInput = value;
      return "done";
    },
    resolveInput: input.resolveInput,
  };
  registry.register(entry);
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService(defaultPermissionConfig, {
      authorize: input.authorize,
    }),
    permissionBroker: {
      async requestPermission() {
        approvals++;
        return input.modifyByApproval
          ? { decision: "modify", modifiedInput: input.modifyByApproval }
          : { decision: "allow" };
      },
    },
    sessionId: "test-session" as SessionId,
    workingDirectory: "/controlled/workspace",
    workspaceRoot: "/controlled/workspace",
    workspaceIdentity: "controlled-identity",
    mode: input.mode ?? "yolo",
    emitEvent: async (event) => {
      events.push(event);
    },
    hookRunner: input.hookRunner,
  });
  return {
    events,
    run: (signal?: AbortSignal) =>
      executor.execute({ id: "call-1", name: "Bash", input: { command: "original" } }, { signal }),
    counts: () => ({ executions, approvals }),
    observedInput: () => observedInput,
  };
}

test("enterprise denial precedes yolo and prevents even PreToolUse side effects", async () => {
  let hooks = 0;
  const f = setup({
    authorize: async () => ({ allowed: false, code: "enterprise_shell_denied" }),
    hookRunner: {
      async run() {
        hooks++;
        return { additionalContexts: [], permissionBehavior: "allow" };
      },
    },
  });
  const result = await f.run();
  assert.equal(result.success, false);
  assert.match(result.error?.message ?? "", /enterprise_shell_denied/);
  assert.deepEqual(f.counts(), { executions: 0, approvals: 0 });
  assert.equal(hooks, 0);
});

test("a Hook allow and changed input cannot override final enterprise admission", async () => {
  const inputs: unknown[] = [];
  const f = setup({
    authorize: async (request) => {
      inputs.push(request.input);
      return { allowed: request.phase === "before_hooks", code: "enterprise_target_denied" };
    },
    hookRunner: {
      async run() {
        return {
          additionalContexts: [],
          permissionBehavior: "allow",
          updatedInput: { command: "changed-by-hook" },
        };
      },
    },
  });
  const result = await f.run();
  assert.equal(result.success, false);
  assert.equal(f.counts().executions, 0);
  assert.deepEqual(inputs, [{ command: "original" }, { command: "changed-by-hook" }]);
  assert.equal(
    f.events.filter((event) => event.type === SessionEventType.ToolCallStarted).length,
    1,
  );
  assert.equal(f.events.filter((event) => event.type === SessionEventType.ToolCallError).length, 1);
  assert.equal(f.events.at(-1)?.type, SessionEventType.ToolCallError);
});

test("user approval modifying input cannot reuse an earlier enterprise decision", async () => {
  const inputs: unknown[] = [];
  const f = setup({
    mode: "build",
    modifyByApproval: { command: "changed-by-broker" },
    authorize: async (request) => {
      inputs.push(request.input);
      return { allowed: request.phase === "before_hooks", code: "enterprise_target_denied" };
    },
  });
  assert.equal((await f.run()).success, false);
  assert.deepEqual(f.counts(), { executions: 0, approvals: 1 });
  assert.deepEqual(inputs, [{ command: "original" }, { command: "changed-by-broker" }]);
});

test("a missing Host response fails closed rather than dispatching a yolo tool", async () => {
  const f = setup({
    authorize: async () => {
      throw new Error("controlled unavailable");
    },
  });
  const result = await f.run();
  assert.equal(result.success, false);
  assert.match(result.error?.message ?? "", /enterprise_policy_unavailable/);
  assert.equal(f.counts().executions, 0);
});

test("a late enterprise allow after cancellation cannot execute a tool", async () => {
  const controller = new AbortController();
  const f = setup({
    authorize: async () => {
      controller.abort();
      return { allowed: true, code: "allowed" };
    },
  });
  await f.run(controller.signal);
  assert.equal(f.counts().executions, 0);
});

test("enterprise denial also precedes a tool's effectful input resolver", async () => {
  let resolutions = 0;
  const f = setup({
    authorize: async () => ({ allowed: false, code: "enterprise_shell_denied" }),
    resolveInput: (input) => {
      resolutions++;
      return { result: true, input };
    },
  });
  assert.equal((await f.run()).success, false);
  assert.equal(resolutions, 0);
  assert.equal(f.counts().executions, 0);
});

test("an authorization adapter cannot mutate the input later consumed by the tool handler", async () => {
  const f = setup({
    authorize: async (request) => {
      if (request.phase === "before_dispatch")
        (request.input as Record<string, unknown>).command = "mutated-by-authorizer";
      return { allowed: true, code: "allowed" };
    },
  });
  assert.equal((await f.run()).success, true);
  assert.deepEqual(f.observedInput(), { command: "original" });
});
