import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createContext, createElement, useEffect, useRef, useState } from "react";
import createReconciler from "react-reconciler";
import { ConcurrentRoot, DefaultEventPriority } from "react-reconciler/constants.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { TabStoreProvider, useTabStore } from "../src/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "../src/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionService } from "../src/hooks/useZCodeSessionService.js";
import { useZCodeAgentService } from "../src/hooks/useZCodeAgentService.js";
import { useZCodeTaskService } from "../src/hooks/useZCodeTaskService.js";
import { REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE } from "../src/lib/remoteWorkspaceServiceError.js";

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

const serviceHooks = [
  ["session", useZCodeSessionService],
  ["agent", useZCodeAgentService],
  ["task", useZCodeTaskService],
];
function serviceSet(owner) {
  const calls = { count: 0 };
  const service = {
    probe: () => {
      calls.count++;
      return owner;
    },
  };
  return {
    calls,
    services: {
      zcodeSessionService: service,
      zcodeAgentService: service,
      zcodeTaskService: service,
    },
  };
}
async function mount(t, hook, options = {}) {
  const previousLogging = globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__;
  const previousConsoleError = console.error;
  const previousRemote = useRemoteWorkspaceSessionStore.getState();
  globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ = true;
  const consoleErrors = [];
  console.error = () => consoleErrors.push("react-console-error");
  useRemoteWorkspaceSessionStore.setState({
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
  });
  const context = serviceSet("context");
  const base = serviceSet("base");
  const remoteA = serviceSet("remote-a");
  const remoteB = serviceSet("remote-b");
  useRemoteWorkspaceSessionStore.getState().registerBaseServices(base.services);
  let current;
  let mounts = 0;
  let unmounts = 0;
  let path = options.path;
  let remoteSessionId = options.remoteSessionId;
  let identity = options.identity;
  const errors = [];
  function Probe() {
    const service = hook(path, remoteSessionId, identity);
    const [state, setState] = useState("initial");
    const ref = useRef({ marker: "same-ref" });
    useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    current = { service, state, setState, ref: ref.current };
    return null;
  }
  const root = renderer.createContainer(
    {},
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    (error) => errors.push(error?.name ?? "unknown"),
    (error) => errors.push(error?.name ?? "unknown"),
    (error) => errors.push(error?.name ?? "unknown"),
    null,
  );
  const element = () =>
    createElement(
      ServiceProvider,
      { services: context.services },
      options.withoutTabs
        ? createElement(Probe)
        : createElement(TabStoreProvider, null, createElement(Probe)),
    );
  t.after(async () => {
    try {
      await act(async () => renderer.updateContainer(null, root, null, noop));
    } finally {
      useRemoteWorkspaceSessionStore.setState(previousRemote, true);
      console.error = previousConsoleError;
      globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ = previousLogging;
    }
  });
  const render = async () => act(async () => renderer.updateContainer(element(), root, null, noop));
  await render();
  return {
    get current() {
      return current;
    },
    get mounts() {
      return mounts;
    },
    get unmounts() {
      return unmounts;
    },
    errors,
    consoleErrors,
    context,
    base,
    remoteA,
    remoteB,
    update: async (next) => {
      path = next.path;
      remoteSessionId = next.remoteSessionId;
      identity = next.identity;
      await render();
    },
    setState: async (next) => act(async () => current.setState(next)),
    mutateRemote: async (action) =>
      act(async () => action(useRemoteWorkspaceSessionStore.getState())),
  };
}
for (const [label, hook] of serviceHooks) {
  test(`${label}: absent → restored path → absent keeps the same real Hook consumer`, async (t) => {
    const f = await mount(t, hook);
    assert.deepEqual(f.errors, []);
    assert.equal(
      f.current.service.probe(),
      "context",
      "no path uses current Context, not registered base",
    );
    const initialRef = f.current.ref;
    await f.setState("keep-me");
    await f.update({ path: "/owned/restored-workspace" });
    assert.deepEqual(f.errors, [], "restoring a path must not change Hook slots");
    assert.equal(f.current.service.probe(), "base");
    assert.equal(f.current.state, "keep-me");
    assert.equal(f.current.ref, initialRef);
    await f.update({ path: undefined });
    assert.deepEqual(f.errors, [], "clearing a path must not change Hook slots");
    assert.equal(f.current.service.probe(), "context");
    assert.equal(f.current.state, "keep-me");
    assert.equal(f.current.ref, initialRef);
    assert.equal(f.mounts, 1);
    assert.equal(f.unmounts, 0);
    assert.deepEqual(f.consoleErrors, []);
  });
  test(`${label}: no path works without Tab provider and preserves current Context`, async (t) => {
    const f = await mount(t, hook, { withoutTabs: true });
    assert.deepEqual(f.errors, []);
    assert.equal(f.current.service.probe(), "context");
    assert.equal(f.base.calls.count, 0);
    assert.equal(f.mounts, 1);
  });
  test(`${label}: a real workspace still requires its Tab provider`, async (t) => {
    await assert.rejects(
      mount(t, hook, { withoutTabs: true, path: "/owned/workspace" }),
      (error) => error?.message === "useTabStore 必须在 TabStoreProvider 内使用",
    );
  });
  test(`${label}: remote identity keeps its owner and a missing registry rejects local fallback`, async (t) => {
    const f = await mount(t, hook, {
      path: "/owned/shared-path",
      identity: "remote-identity-a",
      remoteSessionId: "remote-a",
    });
    await f.mutateRemote((state) => {
      state.registerSession({ sessionId: "remote-a", services: f.remoteA.services });
      state.registerSession({ sessionId: "remote-b", services: f.remoteB.services });
      state.bindWorkspaceIdentity("remote-identity-a", "remote-a");
      state.bindWorkspaceIdentity("remote-identity-b", "remote-b");
    });
    // The first case separately covers the absent/present transition.
    assert.deepEqual(f.errors, []);
    assert.equal(f.current.service.probe(), "remote-a");
    await f.update({
      path: "/owned/shared-path",
      identity: "remote-identity-b",
      remoteSessionId: "remote-b",
    });
    assert.equal(f.current.service.probe(), "remote-b");
    await f.mutateRemote((state) => state.unregisterSession("remote-b"));
    await assert.rejects(
      f.current.service.probe(),
      (error) => error?.code === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
    );
    assert.equal(f.base.calls.count, 0);
    assert.equal(f.context.calls.count, 0);
  });
}

test("required Tab provider rejects before evaluating its selector", async (t) => {
  let evaluations = 0;
  const hook = () =>
    useTabStore(() => {
      evaluations++;
      throw new Error("SELECTOR_MUST_NOT_RUN");
    });
  await assert.rejects(
    mount(t, hook, { withoutTabs: true }),
    (error) => error?.message === "useTabStore 必须在 TabStoreProvider 内使用",
  );
  assert.equal(evaluations, 0);
});
