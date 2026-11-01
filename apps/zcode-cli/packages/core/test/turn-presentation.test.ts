import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTurnPresentation } from "../src/runtime/methods/turn-presentation.js";
import { createRootTraceContext } from "@zcode/contracts";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("a turn captures one current surface without altering the next turn's admission", async () => {
  let surface: "terminal" | "zcode_desktop" = "zcode_desktop",
    reads = 0;
  const runtime = {
    config: { presentationSurface: "terminal" as "terminal" | "zcode_desktop" },
    turnPresentationPort: {
      read: async () => {
        reads++;
        return surface;
      },
    },
  };
  const signal = new AbortController().signal;
  await applyTurnPresentation(runtime, signal, createRootTraceContext());
  surface = "terminal";
  assert.equal(
    runtime.config.presentationSurface,
    "zcode_desktop",
    "a later policy cannot mutate the captured turn",
  );
  assert.equal(reads, 1);
  await applyTurnPresentation(runtime, signal, createRootTraceContext());
  assert.equal(runtime.config.presentationSurface, "terminal");
  assert.equal(reads, 2, "the next executing turn reads again");
});

test("cancelled and changed-owner reads cannot apply a late desktop surface", async () => {
  const cancellation = new AbortController();
  const runtime = {
    config: { presentationSurface: "terminal" as const },
    turnPresentationPort: {
      read: async ({ signal }: { signal: AbortSignal }) => {
        assert.equal(signal, cancellation.signal);
        cancellation.abort();
        return "zcode_desktop" as const;
      },
    },
  };
  await assert.rejects(
    applyTurnPresentation(runtime, cancellation.signal, createRootTraceContext()),
  );
  assert.equal(runtime.config.presentationSurface, "terminal");
  runtime.turnPresentationPort.read = async () => {
    throw new Error("enterprise_identity_changed");
  };
  await assert.rejects(
    applyTurnPresentation(runtime, new AbortController().signal, createRootTraceContext()),
    /enterprise_identity_changed/,
  );
  assert.equal(runtime.config.presentationSurface, "terminal");
});

test("actual turn preparation reserves first, preserves terminal outcomes and releases on cancelled metadata", async () => {
  const path = new URL("../src/runtime/methods/turn.ts", import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (item) => ts.isFunctionDeclaration(item) && item.name?.text === "executeTurnCommand",
  );
  assert.ok(declaration);
  let reserved = false,
    modelAdmissions = 0,
    reads = 0;
  const outcomes: Array<{ turnPhase: string }> = [];
  const controller = new AbortController();
  let cancel = false;
  let nextSurface: "terminal" | "zcode_desktop" = "terminal";
  const trace = createRootTraceContext();
  const runtime = {
    config: { presentationSurface: "zcode_desktop", outputStyle: undefined },
    sessionId: "controlled",
    turnNumber: 0,
    rootTraceContext: trace,
    getSessionModelSelection() {
      return undefined;
    },
    reserveTurnStart() {
      assert.equal(reserved, false);
      reserved = true;
    },
    releaseTurnStart() {
      reserved = false;
    },
    finishActiveTurn() {},
    // 主干的活动轮对象由 runtime 持有；夹具给最小可用状态，供 steer/取消路径读取。
    beginActiveTurn(turnId: string, traceContext: unknown, kind: string) {
      return {
        kind,
        goalStateChangeReminderDeferralOpen: false,
        pendingInputs: [],
        pendingSteerInputs: [],
        steerable: true,
        traceContext,
        turnId,
      };
    },
    turnPresentationPort: {
      async read() {
        reads++;
        assert.equal(reserved, true, "network read is after the one original reservation");
        if (cancel) controller.abort();
        return nextSurface;
      },
    },
    agentTelemetry: {
      turn: () => ({
        run: (fn: () => unknown) => fn(),
        finishCompleted() {},
        finishFailed() {},
        finishCancelled() {},
      }),
    },
    // 主干 turn 实现会接触运行时其余端口；本夹具只验证呈现与预留顺序，
    // 其余端口给最小空实现，避免 eval 出的函数在半途因缺方法中断。
    contextInitialized: false,
    currentTurnFileChanges: new Map(),
    queueAutoDrain: false,
    queueExternalDrainActive: false,
    activeForegroundExecution: undefined,
    workingDirectory: "/tmp/controlled",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    messageHistory: {
      borrowReadOnlyRuntimeEntries: () => [],
      addEntries: () => {},
    },
    artifactStore: {},
    browserControlPort: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    sessionStore: {},
    createEvent: () => ({}),
    appendEvent: async () => {},
    ensureContextInitialized: async () => {},
    ensureSessionPersisted: async () => {},
    executeManualCompact: async () => undefined,
    executeRewindCommand: async () => undefined,
    fallbackPendingGuidesToQueue: () => {},
    startTargetTurnAccounting: () => {},
    heartbeatTargetTurnAccounting: () => {},
    finishTargetTurnAccounting: () => {},
    accountTargetTurnCompletion: () => {},
    trackResidencyBlockingWork: () => Promise.resolve(),
    injectHookAdditionalContextIntoMessageHistory: () => {},
    injectPluginReferenceReminderFromTurn: () => {},
    pauseActiveTargetForCancellation: () => {},
    persistPendingModelChangeTimeline: () => {},
    persistSyntheticUserNoticeForSession: async () => {},
    persistUserPrompt: async () => {},
    prepareAgentDefinitions: async () => {},
    readSessionTargetForContext: () => undefined,
    rebuildProjection: async () => ({ pendingSteerInputs: [] }),
    runSessionStartHooks: async () => {},
    runUserPromptSubmitHooks: async () => {},
  };
  const code = ts.transpileModule(
    `${declaration.getText(source).replace(/^export\s+/u, "")}\nexecuteTurnCommand;`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    },
  ).outputText;
  // 状态机只用于记录轮状态；夹具用同一个可重入实现承接 create/start/complete。
  class ControlledTurnMachine {
    constructor(public state: { startedAt: Date; phase: string }) {}
    static create() {
      return new ControlledTurnMachine({ startedAt: new Date(), phase: "running" });
    }
    start() {
      return { startedAt: this.state.startedAt, phase: "running" };
    }
    complete() {
      return { startedAt: this.state.startedAt, phase: "completed" };
    }
  }
  const execute = runInNewContext(code, {
    Date,
    performance,
    clearInterval,
    createTurnId: () => "controlled-turn",
    createQueryId: () => "controlled-query",
    createChildTraceContext: () => trace,
    parseCompactCommand: () => null,
    parseRewindCommand: () => null,
    TurnMachineImpl: ControlledTurnMachine,
    beginLocalTurnPreparation: () => () => {},
    // 本夹具只驱动呈现/预留顺序；闲时轮绑定由真实运行时提供，这里保持"无闲时轮"。
    prepareOffPeakTurn: (_runtime: unknown, options: unknown) => ({
      options,
      release: () => {},
    }),
    // 项目记忆预取由真实运行时持有，夹具没有该 owner，终态清理是空实现。
    disposeProjectMemoryRecallPrefetch: () => {},
    runWithContextAsync: (_trace: unknown, fn: () => unknown) => fn(),
    createTurnAbortScope: (signal?: AbortSignal) => ({
      signal: signal ?? new AbortController().signal,
      dispose() {},
    }),
    throwIfTurnAborted: (signal: AbortSignal) => signal.throwIfAborted(),
    applyTurnPresentation,
    createTurnModel: () => {
      modelAdmissions++;
      assert.equal(runtime.config.presentationSurface, nextSurface);
      throw new Error("controlled-model-stop");
    },
    createTurnFailureError: (error: Error) => error,
    appendTurnOutcomeEvent: async (_runtime: unknown, outcome: { turnPhase: string }) => {
      outcomes.push(outcome);
    },
    isTurnCancellationError: (_error: unknown, signal: AbortSignal) => signal.aborted,
    clearBrowserTurnState() {},
    // 主干侧新增的模块级依赖：本夹具只驱动呈现与预留顺序，这里给最小空实现，
    // 保证 eval 出来的函数能走到 createTurnModel 的受控失败点。
    CoreErrorType: new Proxy({}, { get: (_target, key) => String(key) }),
    HookEventName: new Proxy({}, { get: (_target, key) => String(key) }),
    SessionEventType: new Proxy({}, { get: (_target, key) => String(key) }),
    ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH: "default-index",
    MODEL_CREATION_FAILED_MESSAGE: "model_creation_failed",
    TURN_CONFIGURATION_UNAVAILABLE_MESSAGE: "turn_configuration_unavailable",
    TURN_EXECUTION_FAILED_MESSAGE: "turn_execution_failed",
    TARGET_RUN_HEARTBEAT_MS: 15000,
    withConversationQuotes: (text: string) => text,
    ensureGroupTaskPermissionScope: async () => {},
    createMessageId: () => "controlled-message",
    createModelUsageSummaryFromEvents: () => ({}),
    createPromptAttachmentAuthorizationContext: () => ({}),
    runtimeInputMetadata: () => ({}),
    runtimeMetadataForSyntheticUserMessageSource: () => ({}),
    traceContextToLogContext: () => ({}),
    buildUserContentFromTurn: () => [],
    buildRuntimeUserEntriesFromTurn: () => [],
    injectDateChangeReminderIntoMessageHistory: () => {},
    injectReferencedSessionContextReminderIntoMessageHistory: () => {},
    resolveTurnAttachments: async () => [],
    summarizeTurnAttachmentsForEvent: () => [],
    logResolvedTurnAttachments: () => {},
    maybeStartSessionTitleGeneration: async () => {},
    maybeStartDeferredSessionTitleGeneration: async () => {},
    recordTurnUsageFact: async () => {},
    applySubmissionExecutionState: () => {},
    matchExecutionSelectionCreationFallback: () => undefined,
    resolveExecutionFallbackCandidates: () => [],
    resolveExecutionModelRetryBudget: () => 0,
    toModelSelection: (value: unknown) => value,
    fromModelSelection: (value: unknown) => value,
    rebuildContextPrefix: async () => {},
    startProjectMemoryRecallPrefetch: () => {},
    scheduleProjectMemoryExtraction: () => {},
    finishOutputTokenRecovery: () => {},
    persistStableForkCompletionBoundary: async () => {},
    appendBrowserTurnScreenshot: async () => {},
    openGoalStateChangeReminderDeferral: () => {},
    closeGoalStateChangeReminderDeferral: () => {},
    runRegularTurnLoop: async () => undefined,
  }) as (
    this: typeof runtime,
    input: string,
    attachments?: unknown,
    options?: { abortSignal: AbortSignal },
  ) => Promise<unknown>;
  await assert.rejects(execute.call(runtime, "first"), /controlled-model-stop/);
  assert.equal(modelAdmissions, 1, "terminal metadata still reaches the original model admission");
  assert.equal(reserved, false);
  nextSurface = "zcode_desktop";
  await assert.rejects(execute.call(runtime, "next"), /controlled-model-stop/);
  assert.equal(modelAdmissions, 2);
  cancel = true;
  await assert.rejects(
    execute.call(runtime, "cancel", undefined, { abortSignal: controller.signal }),
  );
  assert.equal(modelAdmissions, 2);
  assert.equal(reads, 3);
  // 主干把取消经 abort scope 收口，终态相位停在检查点（user_prompt_hooks）；
  // 适配版实现曾在呈现阶段直接失败并报 presentation_preferences。两者都记录终态事实，
  // 这里只要求终态相位属于创建期，不把实现细节钉死。
  assert.ok(
    ["presentation_preferences", "model_creation", "user_prompt_hooks"].includes(
      outcomes.at(-1)?.turnPhase ?? "",
    ),
    `unexpected terminal phase: ${outcomes.at(-1)?.turnPhase}`,
  );
  assert.equal(reserved, false);
});
