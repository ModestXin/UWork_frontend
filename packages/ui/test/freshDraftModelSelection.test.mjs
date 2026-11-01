import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createContext, createElement, useEffect } from "react";
import createReconciler from "react-reconciler";
import { ConcurrentRoot, DefaultEventPriority } from "react-reconciler/constants.js";
import {
  ModelSelectionFacade,
  ProviderRegistry,
  parseModelConfig,
  parseProviderConfig,
} from "@zcode/provider";
import { createModelSelectionService } from "../../services/src/model-provider/providerFacadeServices.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import { useDraftConfigControl } from "../src/v4/composer/useDraftConfigControl.js";
import { seedImportedSessionDraft } from "../src/v4/composer/newTaskDraft.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "../src/v4/composer/composerDraftStore.js";

// Installed React 19 renderer; the probe returns null, so no DOM/browser or business runtime exists.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
const renderer = createReconciler({
  isPrimaryRenderer: false,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  getRootHostContext: () => ({}),
  getChildHostContext: (context) => context,
  getPublicInstance: (instance) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: noop,
  clearContainer: noop,
  createInstance: () => ({}),
  createTextInstance: (text) => ({ text }),
  appendInitialChild: noop,
  appendChild: noop,
  appendChildToContainer: noop,
  removeChild: noop,
  removeChildFromContainer: noop,
  insertBefore: noop,
  insertInContainerBefore: noop,
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  commitUpdate: noop,
  commitTextUpdate: noop,
  resetTextContent: noop,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  getCurrentUpdatePriority: () => DefaultEventPriority,
  setCurrentUpdatePriority: noop,
  trackSchedulerEvent: noop,
  resolveUpdatePriority: () => DefaultEventPriority,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1,
  shouldAttemptEagerTransition: () => false,
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: createContext(null),
  resetFormInstance: noop,
});
class MemoryStorage {
  #values = new Map();
  getItem(key) {
    return this.#values.get(key) ?? null;
  }
  setItem(key, value) {
    this.#values.set(key, value);
  }
  removeItem(key) {
    this.#values.delete(key);
  }
}
const allowed = {
  providerId: "ucas",
  modelId: "allowed-opaque",
  options: { reasoningLevel: "disabled" },
};
const legacy = {
  providerId: "ucas",
  modelId: "ucas-deepseek-flash",
  options: { reasoningLevel: "max" },
};
function provider(ids) {
  return {
    providerId: "ucas",
    providerName: "ucas",
    templateId: "ucas",
    config: parseProviderConfig({
      group: "standard-personal",
      access: { type: "enterprise-session" },
      api: { type: "openai-chat-completions", baseUrl: "https://owned.invalid/v1" },
      visibility: "visible",
      enterpriseModelIds: ids,
      enterpriseModelNames: Object.fromEntries(ids.map((id) => [id, "联动受控模型"])),
    }),
    models: ids.map((modelId) => ({
      modelId,
      config: parseModelConfig({
        enabled: true,
        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 128000,
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
          supportsMidConversationSystem: true,
        },
        optionSpecs: { reasoningLevel: { values: ["disabled"] }, maxOutputTokens: { max: 16 } },
      }),
    })),
  };
}
async function mount(t, options = {}) {
  const previousWindow = globalThis.window;
  const previousLogging = globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__;
  globalThis.window = { localStorage: new MemoryStorage() };
  globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ = true;
  const path = "/owned/fresh-draft-contract";
  let sessionId = options.sessionId ?? null;
  if (options.draft)
    persistV4ComposerDraft(path, undefined, sessionId ?? V4_DRAFT_SCOPE_ROOT, options.draft);
  const registry = new ProviderRegistry(options.ids?.length ? [provider(options.ids)] : []);
  const source = {
    getView: () => registry.getView(),
    getSnapshot: () => ({ registry: registry.getView(), account: { states: {} } }),
    onDidChange: (listener) => registry.onDidChange(() => listener({})),
  };
  const service = createModelSelectionService(new ModelSelectionFacade(source), async () => {}, {
    read: async () => legacy,
  });
  let current,
    mounts = 0;
  const services = {
    settingService: { get: async () => ({}) },
    zcodeSessionService: {},
    broadcastService: {},
    zcodeAgentService: {},
  };
  function Probe({ activeSessionId }) {
    current = useDraftConfigControl({
      workspacePath: path,
      sessionId: activeSessionId,
      sessionConfig: options.sessionConfig,
      modelSelectionService: service,
      // Only suppress unrelated workspace/Agent preparation; real selection subscriptions remain enabled.
      agentStartupAllowed: false,
    });
    useEffect(() => {
      mounts++;
    }, []);
    return null;
  }
  const errors = [];
  const root = renderer.createContainer(
    {},
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    (error) => errors.push(error),
    (error) => errors.push(error),
    (error) => errors.push(error),
    null,
  );
  const element = () =>
    createElement(
      ServiceProvider,
      { services },
      createElement(
        PlatformProvider,
        { platform: {} },
        createElement(TabStoreProvider, null, createElement(Probe, { activeSessionId: sessionId })),
      ),
    );
  t.after(async () => {
    await act(async () => renderer.updateContainer(null, root, null, noop));
    service.dispose();
    globalThis.window = previousWindow;
    globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ = previousLogging;
  });
  await act(async () => renderer.updateContainer(element(), root, null, noop));
  assert.deepEqual(errors, [], "real Hook must mount without renderer errors");
  return {
    path,
    get control() {
      return current;
    },
    get mounts() {
      return mounts;
    },
    view: (input) => service.getView(input),
    publish: async (ids) =>
      act(async () => registry.replace(ids.length ? [provider(ids)] : [], "owned-catalog-arrived")),
    perform: async (action) => act(async () => action(current)),
    stored: () => readV4ComposerDraft(path, undefined, sessionId ?? V4_DRAFT_SCOPE_ROOT),
    switchSession: async (next) => {
      sessionId = next;
      await act(async () => renderer.updateContainer(element(), root, null, noop));
    },
    restart: async () => {
      await act(async () => renderer.updateContainer(null, root, null, noop));
      await act(async () => renderer.updateContainer(element(), root, null, noop));
    },
  };
}

test("same fresh draft picks its first valid default after ready empty catalog becomes managed", async (t) => {
  const f = await mount(t);
  assert.equal(f.control.composerDraft.mode, "build");
  assert.equal(f.control.modelSelectionRead.state.status, "ready");
  assert.deepEqual(f.control.modelSelectionRead.state.view.providers, []);
  assert.equal(f.control.draftConfig.modelSelection, undefined);
  await f.publish(["allowed-opaque"]);
  const view = await f.view({ selection: null });
  assert.deepEqual(
    view.preferredSelection,
    allowed,
    "real Host service has the legal filtered default",
  );
  assert.equal(
    f.control.modelSelectionRead.state.view.providers[0].models[0].modelId,
    allowed.modelId,
    "original Hook received the actual service event and reread the catalog",
  );
  assert.equal(f.mounts, 1, "no remount or manual model selection");
  assert.deepEqual(
    f.control.draftConfig.modelSelection,
    allowed,
    "fresh empty draft must consume the first legal default without user selection",
  );
});

test("late default preserves text and an explicit plan/mode change in the original fresh draft", async (t) => {
  const f = await mount(t);
  await f.perform((control) => control.updateComposerContent({ text: "keep my draft" }));
  await f.perform((control) => control.handleDraftSwitchMode("plan"));
  assert.equal(f.control.composerDraft.initializeFromNewTask, true);
  await f.publish(["allowed-opaque"]);
  assert.deepEqual(f.control.draftConfig.modelSelection, allowed);
  assert.equal(f.control.composerDraft.text, "keep my draft");
  assert.equal(f.control.composerDraft.mode, "build");
  assert.equal(f.control.composerDraft.planEnabled, true);
  assert.equal(f.control.composerDraft.initializeFromNewTask, undefined);
  assert.equal(f.mounts, 1);
});

test("pending model initialization survives the real draft codec with an already initialized mode", async (t) => {
  const f = await mount(t);
  await f.perform((control) => control.updateComposerContent({ text: "cold pending text" }));
  assert.equal(f.stored().mode, "build");
  assert.equal(f.stored().initializeFromNewTask, true);
  await f.restart();
  assert.equal(f.control.composerDraft.initializeFromNewTask, true);
  await f.publish(["allowed-opaque"]);
  assert.deepEqual(f.control.draftConfig.modelSelection, allowed);
  assert.equal(f.control.composerDraft.text, "cold pending text");
});

test("explicit model intent before catalog delivery is retained, including an unset reasoning option", async (t) => {
  const f = await mount(t);
  await f.perform((control) => control.handleDraftSelectModel("ucas", "chosen-explicit"));
  await f.publish(["allowed-opaque", "chosen-explicit"]);
  assert.deepEqual(f.control.composerDraft.modelSelection, {
    providerId: "ucas",
    modelId: "chosen-explicit",
  });
  assert.equal(f.control.composerDraft.initializeFromNewTask, undefined);
  assert.equal(f.control.draftConfig.modelSelection.modelId, "chosen-explicit");
  assert.equal(f.control.draftConfig.modelSelection.options, undefined);
});

test("explicit empty replacement ends fresh eligibility instead of being refilled on the next event", async (t) => {
  const f = await mount(t);
  await f.perform((control) =>
    control.replaceComposerDraft({ text: "explicit empty", mode: "build" }),
  );
  await f.publish(["allowed-opaque"]);
  assert.equal(f.control.draftConfig.modelSelection, undefined);
  assert.equal(f.control.composerDraft.initializeFromNewTask, undefined);
  assert.equal(f.control.composerDraft.text, "explicit empty");
});

test("unmarked mode+empty and historical model intent never acquire fresh eligibility", async (t) => {
  const cases = [
    { draft: { text: "legacy empty", mode: "build" }, expected: undefined },
    { draft: { text: "legacy chosen", mode: "build", modelSelection: legacy }, expected: legacy },
    {
      sessionId: "existing-session",
      sessionConfig: { mode: "build", modelSelection: legacy },
      expected: legacy,
    },
    { sessionId: "empty-session", sessionConfig: { mode: "build" }, expected: undefined },
  ];
  for (const [index, options] of cases.entries())
    await t.test(String(index), async (sub) => {
      const f = await mount(sub, options);
      await f.publish(["allowed-opaque"]);
      assert.deepEqual(f.control.composerDraft.modelSelection, options.expected);
      assert.equal(f.control.draftConfig.modelSelection, undefined);
      assert.equal(f.control.composerDraft.initializeFromNewTask, undefined);
    });
});

test("a still-empty catalog does not recover configured legacy seed or consume pending eligibility", async (t) => {
  const f = await mount(t);
  await f.publish([]);
  assert.equal((await f.view()).preferredSelection, undefined);
  assert.equal(f.control.composerDraft.modelSelection, undefined);
  assert.equal(f.control.draftConfig.modelSelection, undefined);
  assert.equal(f.control.composerDraft.initializeFromNewTask, true);
  assert.equal(f.mounts, 1);
});

test("an accepted first selection is not replaced by a later authorized default", async (t) => {
  const f = await mount(t);
  await f.publish(["allowed-opaque"]);
  await f.perform((control) => control.captureAcceptedModelSelection(allowed)());
  assert.equal(f.control.composerDraft.initializeFromNewTask, undefined);
  await f.publish(["new-default"]);
  assert.equal((await f.view()).preferredSelection.modelId, "new-default");
  assert.deepEqual(f.control.composerDraft.modelSelection, allowed);
  assert.equal(f.control.draftConfig.modelSelection, undefined);
});

test("first import preserves explicit pending qualification after mode initialization", async (t) => {
  const f = await mount(t);
  await f.perform((control) => control.updateComposerContent({ text: "root text stays in root" }));
  await f.perform((control) => control.handleDraftSwitchMode("plan"));
  seedImportedSessionDraft({ workspacePath: f.path, sessionId: "first-import", reused: false });
  await f.switchSession("first-import");
  assert.equal(f.control.composerDraft.initializeFromNewTask, true);
  assert.equal(f.control.composerDraft.text, "");
  await f.publish(["allowed-opaque"]);
  assert.deepEqual(f.control.draftConfig.modelSelection, allowed);
  assert.equal(f.control.composerDraft.planEnabled, true);
  assert.equal(f.mounts, 1);
});

test("first import never guesses unmarked mode+empty as fresh pending", async (t) => {
  const f = await mount(t, { draft: { mode: "build", text: "old empty model" } });
  seedImportedSessionDraft({ workspacePath: f.path, sessionId: "old-empty-import", reused: false });
  await f.switchSession("old-empty-import");
  await f.publish(["allowed-opaque"]);
  assert.equal(f.control.composerDraft.initializeFromNewTask, undefined);
  assert.equal(f.control.draftConfig.modelSelection, undefined);
});
