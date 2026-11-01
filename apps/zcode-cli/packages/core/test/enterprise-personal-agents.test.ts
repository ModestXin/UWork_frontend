import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CoreErrorType,
  InMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  runWithModelInvocationContext,
  type EnterpriseToolAuthorizationRequest,
  type Model,
  type FileSystemPort,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createDefaultSubagentPort } from "../src/runtime/methods/subagent.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentRuntimeDeps } from "../src/runtime/types.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import {
  authorizePersonalAgentProfile,
  withPersonalAgentModelAuthorization,
  type PersonalAgentAuthorizationContext,
} from "../src/subagent/enterprise-profile-authorization.js";

const request = { messages: [{ role: "user" as const, content: "controlled" }] };

function hasContextCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (
      "context" in current &&
      current.context &&
      typeof current.context === "object" &&
      "code" in current.context &&
      current.context.code === code
    )
      return true;
    current = current.cause;
  }
  return false;
}

function fixture(source: PersonalAgentAuthorizationContext["profile"]["source"] = "user") {
  const state = {
    allowed: true,
    ownerKey: "a".repeat(64) as string | undefined,
    unavailable: false,
    managed: true,
  };
  const admissions: EnterpriseToolAuthorizationRequest[] = [];
  const context: PersonalAgentAuthorizationContext = {
    profile: { name: "personal:user:Controlled", source },
    sessionId: "controlled-parent",
    workspacePath: "/controlled/workspace",
    workspaceIdentity: "controlled-identity",
    workingDirectory: "/controlled/workspace/child",
    traceContext: createRootTraceContext({ sessionId: createSessionId("controlled-parent") }),
    authorization: {
      async authorize(input) {
        admissions.push(structuredClone(input));
        if (state.unavailable) throw new Error("private synthetic error must not escape");
        return {
          allowed: state.allowed,
          code: state.allowed
            ? state.managed
              ? "allowed"
              : "not_managed"
            : "enterprise_personal_agents_denied",
          ...(state.managed ? { ownerKey: state.ownerKey } : {}),
        };
      },
    },
  };
  let generations = 0,
    streams = 0,
    binds = 0;
  const model: Model = {
    providerId: "controlled" as Model["providerId"],
    modelId: "controlled" as Model["modelId"],
    displayName: "controlled",
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 1000,
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
      reasoningLevel: { values: ["none"], map: "return {}" },
      maxOutputTokens: { max: 10, map: "return {}" },
    },
    options: {},
    bind() {
      binds++;
      return model;
    },
    async generateText() {
      generations++;
      return {
        text: "controlled",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async *streamText() {
      streams++;
      yield { type: "start" };
      yield { type: "text_delta", text: "controlled" };
    },
  };
  return { state, admissions, context, model, counts: () => ({ generations, streams, binds }) };
}

test("a resolved personal profile is denied before any personal context or memory access", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uwork-personal-agent-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let personalReads = 0;
  const sessionId = createSessionId("controlled-parent");
  const runtime = {
    sessionId,
    config: {
      subagents: {
        outputRootDir: directory,
        profiles: [
          {
            name: "personal:user:Controlled",
            source: "user",
            description: "controlled",
            systemPrompt: "controlled private profile",
            memory: "user",
          },
        ],
      },
    },
    permissionService: new PermissionService(defaultPermissionConfig, {
      authorize: async () => ({ allowed: false, code: "enterprise_personal_agents_denied" }),
    }),
    get contextSourceSnapshot() {
      personalReads++;
      throw new Error("personal content accessed before current authorization");
    },
  } as unknown as AgentRuntimeInternal;
  const port = createDefaultSubagentPort.call(runtime, {} as AgentRuntimeDeps);
  assert.ok(port);
  await assert.rejects(
    port.run({
      sessionId,
      parentToolCallId: "controlled-call",
      agentType: "personal:user:Controlled",
      description: "controlled",
      prompt: "controlled",
      workingDirectory: directory,
      workspaceRoot: directory,
      trace: createRootTraceContext({ sessionId }),
    }),
    /enterprise_personal_agents_denied/,
  );
  assert.equal(personalReads, 0);
});

for (const source of ["user", "project"] as const)
  test(`resolved ${source} profile admissions use current scope and bounded credential-free metadata`, async () => {
    const f = fixture(source);
    const decision = await authorizePersonalAgentProfile(f.context);
    assert.equal(decision?.ownerKey, f.state.ownerKey);
    assert.equal(f.admissions.length, 1);
    const [admission] = f.admissions;
    assert.equal(admission!.toolName, "PersonalAgentProfileLoad");
    assert.equal(admission!.capability.permission, "personal_agent");
    assert.equal(admission!.phase, "before_dispatch");
    assert.equal(admission!.sessionId, f.context.sessionId);
    assert.equal(admission!.workspacePath, f.context.workspacePath);
    assert.equal(admission!.workspaceIdentity, f.context.workspaceIdentity);
    assert.equal(admission!.workingDirectory, f.context.workingDirectory);
    assert.deepEqual(admission!.traceContext, f.context.traceContext);
    assert.deepEqual(admission!.input, {});
  });

test("builtin/enterprise profiles and a standalone runtime keep their existing model handles", async () => {
  for (const source of ["built-in", "enterprise"] as const) {
    const f = fixture(source);
    assert.equal(await authorizePersonalAgentProfile(f.context), undefined);
    assert.equal(withPersonalAgentModelAuthorization(f.model, f.context), f.model);
    assert.equal(f.admissions.length, 0);
  }
  const f = fixture();
  const standalone = { ...f.context, authorization: undefined };
  assert.equal(await authorizePersonalAgentProfile(standalone), undefined);
  assert.equal(withPersonalAgentModelAuthorization(f.model, standalone), f.model);
});

test("generate, lazy stream and bind reauthorize every new personal model request", async () => {
  const f = fixture();
  const admitted = await authorizePersonalAgentProfile(f.context);
  const guarded = withPersonalAgentModelAuthorization(f.model, {
    ...f.context,
    expectedOwnerKey: admitted?.ownerKey,
  });
  assert.equal(guarded.providerId, f.model.providerId);
  assert.equal(guarded.properties, f.model.properties);
  assert.equal((await guarded.generateText(request)).text, "controlled");
  const stream = guarded.streamText(request);
  f.state.allowed = false;
  await assert.rejects(async () => {
    for await (const _event of stream) {
      /* denied before underlying iterable */
    }
  }, /enterprise_personal_agents_denied/);
  await assert.rejects(
    guarded.bind({ maxOutputTokens: 2 }).generateText(request),
    /enterprise_personal_agents_denied/,
  );
  assert.deepEqual(f.counts(), { generations: 1, streams: 0, binds: 1 });
  assert.equal(f.admissions.length, 4);
});

test("the current invocation trace reaches the model admission and owner change cannot reuse a prior personal read", async () => {
  const f = fixture();
  const guarded = withPersonalAgentModelAuthorization(f.model, {
    ...f.context,
    expectedOwnerKey: f.state.ownerKey,
  });
  const trace = createRootTraceContext({ sessionId: createSessionId("controlled-current-child") });
  await runWithModelInvocationContext({ traceContext: trace }, () => guarded.generateText(request));
  assert.deepEqual(f.admissions[0]!.traceContext, trace);
  f.state.ownerKey = "b".repeat(64);
  await assert.rejects(guarded.generateText(request), /enterprise_identity_changed/);
  assert.equal(f.counts().generations, 1);
});

test("unavailable or cancelled personal admission has stable errors and no model dispatch", async () => {
  const f = fixture();
  f.state.unavailable = true;
  const guarded = withPersonalAgentModelAuthorization(f.model, f.context);
  await assert.rejects(
    guarded.generateText(request),
    (error: unknown) => error instanceof Error && error.message === "enterprise_policy_unavailable",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    guarded.generateText({ ...request, abortSignal: controller.signal }),
    (error: unknown) =>
      error instanceof Error &&
      "type" in error &&
      error.type === CoreErrorType.ToolCancelled &&
      error.message === "enterprise_authorization_cancelled",
  );
  assert.equal(f.admissions.length, 1);
  assert.equal(f.counts().generations, 0);
});

test("a managed allow without owner identity cannot authorize personal content or a model", async () => {
  const f = fixture();
  f.state.ownerKey = undefined;
  await assert.rejects(authorizePersonalAgentProfile(f.context), /enterprise_policy_unavailable/);
  await assert.rejects(
    withPersonalAgentModelAuthorization(f.model, f.context).generateText(request),
    /enterprise_policy_unavailable/,
  );
  assert.equal(f.counts().generations, 0);
});

for (const initialManaged of [true, false])
  test(`a personal model admitted as ${initialManaged ? "managed" : "unmanaged"} rejects a later authority mode change`, async () => {
    const f = fixture();
    f.state.managed = initialManaged;
    const admitted = await authorizePersonalAgentProfile(f.context);
    const guarded = withPersonalAgentModelAuthorization(f.model, {
      ...f.context,
      expectedOwnerKey: admitted?.ownerKey,
      expectedManaged: admitted?.code !== "not_managed",
    });
    await guarded.generateText(request);
    f.state.managed = !initialManaged;
    await assert.rejects(guarded.generateText(request), /enterprise_identity_changed/);
    assert.equal(f.counts().generations, 1);
  });

test("a request already dispatched under personal admission keeps its accepted stream", async () => {
  const f = fixture();
  const iterator = withPersonalAgentModelAuthorization(f.model, f.context)
    .streamText(request)
    [Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { type: "start" });
  f.state.allowed = false;
  assert.deepEqual((await iterator.next()).value, { type: "text_delta", text: "controlled" });
  assert.equal((await iterator.next()).done, true);
  assert.equal(f.admissions.length, 1);
  assert.equal(f.counts().streams, 1);
});

for (const modelSource of ["factory", "inherited", "override"] as const)
  test(`actual child ${modelSource} model rechecks revocation after persistent memory awaited`, async (t) => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), "uwork-personal-agent-model-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let memoryReads = 0;
    const sessionId = createSessionId(`controlled-${modelSource}`);
    const selection = { providerId: "controlled", modelId: "controlled" };
    const deps: AgentRuntimeDeps = {
      eventStore: new InMemorySessionEventStore(),
      modelFactory: () => f.model,
      permissionService: new PermissionService(defaultPermissionConfig, f.context.authorization),
      fileSystemPort: {
        async createDirectory() {
          f.state.allowed = false;
        },
        async readTextFile() {
          memoryReads++;
          return { content: "controlled personal memory" };
        },
      } as unknown as FileSystemPort,
    };
    const parent = new AgentRuntime(
      sessionId,
      {
        modelSelection: selection,
        workingDirectory: directory,
        memory: { enabled: true, storageRoot: directory },
        subagents: {
          outputRootDir: directory,
          profiles: [
            {
              name: "personal:user:Controlled",
              source: "user",
              description: "controlled",
              systemPrompt: "controlled",
              memory: "user",
            },
          ],
        },
      },
      deps,
    );
    t.after(() => parent.closeBrowserSession());
    const port = createDefaultSubagentPort.call(parent as unknown as AgentRuntimeInternal, deps);
    assert.ok(port);
    await port
      .run(
        {
          sessionId,
          parentToolCallId: "controlled-call",
          agentType: "personal:user:Controlled",
          description: "controlled",
          prompt: "controlled",
          workingDirectory: directory,
          workspaceRoot: directory,
          trace: createRootTraceContext({ sessionId }),
        },
        {
          ...(modelSource === "inherited" ? { model: f.model } : {}),
          ...(modelSource === "override"
            ? { modelOverride: { selection, background: "deny" as const } }
            : {}),
        },
      )
      .catch((error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(hasContextCode(error, "enterprise_personal_agents_denied"));
      });
    assert.equal(memoryReads, 1, "test must revoke during the actual personal memory await");
    assert.ok(
      f.admissions.filter((input) => input.capability.permission === "personal_agent").length >= 2,
      "both preflight and the actual child Model entry must authorize",
    );
    assert.equal(f.counts().generations, 0);
    assert.equal(f.counts().streams, 0);
  });
