import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createContext, createElement } from "react";
import createReconciler from "react-reconciler";
import { ConcurrentRoot, DefaultEventPriority } from "react-reconciler/constants.js";
import { useModelSelectionServiceView } from "../src/hooks/useModelSelectionView.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
const renderer = createReconciler({
  isPrimaryRenderer: false,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  getRootHostContext: () => ({}),
  getChildHostContext: (value) => value,
  getPublicInstance: (value) => value,
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
const selection = {
  providerId: "ucas",
  modelId: "model-A",
  options: { reasoningLevel: "disabled" },
};
const provider = (type, id = "ucas", modelId = "model-A") => ({
  providerId: id,
  config: { access: { type } },
  models: [{ modelId }],
});
const personal = provider("api-key", "personal", "personal-model");
const managed = provider("enterprise-session");
const initial = (ucas = managed) => ({
  revision: 1,
  providers: [ucas, personal],
  preferredSelection: selection,
  effectiveSelection: selection,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(t, view = initial()) {
  const listeners = new Set();
  let read = async () => view,
    current;
  const service = {
    getView: (input) => read(input),
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  function Probe() {
    current = useModelSelectionServiceView(service, true, "remote-waiting", { selection });
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
    (e) => errors.push(e),
    (e) => errors.push(e),
    (e) => errors.push(e),
    null,
  );
  const oldLogging = globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__;
  globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ = true;
  t.after(async () => {
    await act(async () => renderer.updateContainer(null, root, null, noop));
    globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ = oldLogging;
    assert.deepEqual(errors, []);
  });
  await act(async () => renderer.updateContainer(createElement(Probe), root, null, noop));
  return {
    get state() {
      return current.state;
    },
    read: (next) => {
      read = next;
    },
    publish: async (next) =>
      act(async () => {
        for (const listener of listeners) listener(next);
      }),
  };
}

test("explicit managed removal drops old ready candidates and effective selection while current-input read is held", async (t) => {
  const f = await mount(t),
    held = deferred();
  f.read(() => held.promise);
  try {
    await f.publish({ revision: 2, providers: [personal] });
    assert.equal(f.state.status, "ready");
    assert.deepEqual(f.state.view.providers, [personal]);
    assert.equal(f.state.view.providers[0], personal);
    assert.equal(f.state.view.effectiveSelection, null);
    assert.equal(f.state.view.preferredSelection, undefined);
  } finally {
    await act(async () =>
      held.resolve({ revision: 2, providers: [personal], effectiveSelection: null }),
    );
  }
});

test("late old success cannot restore A after the current B catalog is received", async (t) => {
  const f = await mount(t),
    old = deferred();
  f.read(() => old.promise);
  await f.publish({ revision: 2, providers: [personal] });
  const next = {
    revision: 3,
    providers: [provider("enterprise-session", "ucas", "model-B"), personal],
    effectiveSelection: null,
  };
  f.read(async () => next);
  await f.publish(next);
  await act(async () => old.resolve(initial()));
  assert.equal(f.state.view, next);
  assert.equal(f.state.view.providers[0].models[0].modelId, "model-B");
});

test("ordinary IO refresh failure keeps ready, including ordinary UCAS/API-key", async (t) => {
  for (const ucas of [managed, provider("api-key")]) {
    await t.test(ucas.config.access.type, async (sub) => {
      const view = initial(ucas),
        f = await mount(sub, view);
      f.read(async () => {
        throw Error("controlled-read-failure");
      });
      await f.publish({ ...view, revision: 2 });
      assert.equal(f.state.view, view);
    });
  }
});

test("an ordinary API-key provider is not treated as a managed revocation by an unrelated empty event", async (t) => {
  const view = initial(provider("api-key")),
    f = await mount(t, view);
  f.read(async () => {
    throw Error("controlled-read-failure");
  });
  await f.publish({ revision: 2, providers: [personal] });
  assert.equal(f.state.view, view);
});
