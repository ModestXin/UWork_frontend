import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createContext, createElement, StrictMode } from "react";
import createReconciler from "react-reconciler";
import { ConcurrentRoot, DefaultEventPriority } from "react-reconciler/constants.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "../src/store/TabStoreProvider.js";
import { useRootPlatformEffects } from "../src/root/useRootPlatformEffects.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

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

async function mount(
  t,
  {
    pending = "/explicit-project",
    ready = false,
    strict = false,
    reportedActiveIdentity,
    initialTaskId,
  } = {},
) {
  let store,
    notifications = 0,
    mainReady = false,
    currentReady = ready;
  const opened = [],
    listeners = new Set(),
    errors = [];
  const event = () => noop;
  // Main owns the pending request and releases it once, only after Renderer ready.
  const deliver = () => {
    if (!mainReady || !pending) return;
    const path = pending;
    pending = null;
    for (const listener of listeners) listener(path);
  };
  const platform = {
    onFocusTab: event,
    onNewTab: event,
    onNewTask: event,
    onOpenWorkspace: event,
    onTaskNotificationClick: event,
    onOpenWorkspacePath: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyRendererReady: async () => {
      notifications++;
      mainReady = true;
      deliver();
    },
    syncWindowTabs: noop,
    setApplicationLocale: async () => {},
    syncWindowUnreadCount: noop,
    syncActiveTaskSession: noop,
  };
  const intl = { formatMessage: ({ id }) => id };
  const openWorkspacePath = (path) => {
    opened.push(path);
    store.getState().addTab(path);
  };
  function Probe({ canBootstrap }) {
    store = useTabStoreApi();
    const tabs = useTabStore((state) => state.tabs);
    const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
    const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
    useRootPlatformEffects({
      initialWorkspaceAbsPath: "/startup-default",
      initialTaskId,
      canBootstrapInitialWorkspace: canBootstrap,
      addTab: store.getState().addTab,
      setIsBootstrappingInitialWorkspace: noop,
      platform,
      activateTabByPath: store.getState().activateTabByPath,
      startDraftInWorkspace: noop,
      startNewTaskFromActiveWorkspace: noop,
      openWorkspace: noop,
      openWorkspacePath,
      setWorkspaceActionError: noop,
      allowOpenWorkspace: true,
      isDesktop: true,
      locale: "zh-CN",
      tabs,
      activeWorkspacePath,
      activeWorkspaceIdentity: reportedActiveIdentity ?? activeWorkspaceIdentity,
      totalUnreadTaskCount: 0,
      hasCompletedFullTabRestore: canBootstrap,
      intl,
      isRestoringOAuthSession: !canBootstrap,
    });
    return null;
  }
  const root = renderer.createContainer(
    {},
    ConcurrentRoot,
    null,
    strict,
    null,
    "",
    (e) => errors.push(e),
    (e) => errors.push(e),
    (e) => errors.push(e),
    null,
  );
  const priorLogging = globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__;
  globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ = true;
  const render = async (enabled) =>
    act(async () => {
      currentReady = enabled;
      const tree = createElement(
        TabStoreProvider,
        null,
        createElement(Probe, { canBootstrap: enabled }),
      );
      renderer.updateContainer(
        strict ? createElement(StrictMode, null, tree) : tree,
        root,
        null,
        noop,
      );
    });
  const unmount = async () => act(async () => renderer.updateContainer(null, root, null, noop));
  t.after(async () => {
    await unmount();
    globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ = priorLogging;
    assert.deepEqual(errors, []);
  });
  await render(ready);
  return {
    opened,
    render,
    unmount,
    get notifications() {
      return notifications;
    },
    get active() {
      return store.getState().activeWorkspacePath;
    },
    get paths() {
      return store.getState().tabs.map((tab) => tab.workspacePath);
    },
    restoreHistory: async (path = "/previous-project", options) =>
      act(async () => {
        store.getState().addTab(path, options);
      }),
    openLater: async (path) =>
      act(async () => {
        pending = path;
        deliver();
      }),
    rerender: () => render(currentReady),
  };
}

test("Main keeps the explicit workspace pending while initial restore is held", async (t) => {
  const f = await mount(t);
  assert.equal(f.notifications, 0);
  assert.deepEqual(f.opened, []);
});

test("renderer reload preserves the restored active project instead of replaying a stale initial path", async (t) => {
  t.mock.method(globalThis.performance, "getEntriesByType", () => [{ type: "reload" }]);
  const f = await mount(t, { pending: null });
  await f.restoreHistory();
  await f.render(true);
  assert.equal(f.active, "/previous-project");
  assert.deepEqual(f.paths, ["/previous-project"]);
  assert.equal(f.notifications, 1);
});

test("renderer reload without restored tabs retains the original initial workspace fallback", async (t) => {
  t.mock.method(globalThis.performance, "getEntriesByType", () => [{ type: "reload" }]);
  const f = await mount(t, { pending: null, ready: true });
  assert.equal(f.active, "/startup-default");
  assert.deepEqual(f.paths, ["/startup-default"]);
  assert.equal(f.notifications, 1);
});

test("renderer reload preserves a restored conversation workspace", async (t) => {
  t.mock.method(globalThis.performance, "getEntriesByType", () => [{ type: "reload" }]);
  const f = await mount(t, { pending: null });
  await f.restoreHistory("/conversation", { workspacePurpose: "conversation" });
  await f.render(true);
  assert.equal(f.active, "/conversation");
  assert.deepEqual(f.paths, ["/conversation"]);
});

test("renderer reload matches a restored workspace through its explicit identity", async (t) => {
  t.mock.method(globalThis.performance, "getEntriesByType", () => [{ type: "reload" }]);
  const f = await mount(t, { pending: null });
  await f.restoreHistory("/previous-project", { workspaceIdentity: "restored-project" });
  await f.render(true);
  assert.equal(f.active, "/previous-project");
  assert.deepEqual(f.paths, ["/previous-project"]);
});

test("renderer reload retains fallback when the active identity has no matching restored tab", async (t) => {
  t.mock.method(globalThis.performance, "getEntriesByType", () => [{ type: "reload" }]);
  const f = await mount(t, { pending: null, reportedActiveIdentity: "missing-project" });
  await f.restoreHistory("/previous-project", { workspaceIdentity: "restored-project" });
  await f.render(true);
  assert.equal(f.active, "/startup-default");
  assert.ok(f.paths.includes("/previous-project"));
});

test("renderer reload keeps the current task instead of replaying the window's old initialTaskId", async (t) => {
  t.mock.method(globalThis.performance, "getEntriesByType", () => [{ type: "reload" }]);
  const priorWorkspaces = useZCodeSessionStore.getState().workspaces;
  t.after(() => useZCodeSessionStore.setState({ workspaces: priorWorkspaces }));
  const f = await mount(t, { pending: null, initialTaskId: "old-window-task" });
  await f.restoreHistory("/startup-default");
  useZCodeSessionStore.getState().setActiveTaskId("/startup-default", "current-task");
  await f.render(true);
  assert.equal(f.active, "/startup-default");
  assert.equal(
    useZCodeSessionStore.getState().getWorkspaceState("/startup-default").activeTaskId,
    "current-task",
  );
});

test("a new Main request still wins over restored history during renderer reload", async (t) => {
  t.mock.method(globalThis.performance, "getEntriesByType", () => [{ type: "reload" }]);
  const f = await mount(t);
  await f.restoreHistory();
  await f.render(true);
  assert.equal(f.active, "/explicit-project");
  assert.deepEqual(f.opened, ["/explicit-project"]);
  assert.ok(f.paths.includes("/previous-project"));
});
test("explicit startup request wins after initial workspace restore without dropping history", async (t) => {
  const f = await mount(t);
  await f.restoreHistory();
  await f.render(true);
  assert.equal(f.active, "/explicit-project");
  assert.deepEqual(f.opened, ["/explicit-project"]);
  assert.ok(f.paths.includes("/previous-project"));
});
test("StrictMode and later rerenders do not duplicate the pending Main request", async (t) => {
  const f = await mount(t, { strict: true });
  await f.render(true);
  await f.rerender();
  assert.equal(f.active, "/explicit-project");
  assert.deepEqual(f.opened, ["/explicit-project"]);
});
test("unmount during held restore does not release the pending Main request", async (t) => {
  const f = await mount(t);
  await f.unmount();
  assert.equal(f.notifications, 0);
  assert.deepEqual(f.opened, []);
});
test("normal startup and later explicit workspace opening retain existing behavior", async (t) => {
  const f = await mount(t, { pending: null, ready: true });
  assert.equal(f.active, "/startup-default");
  await f.openLater("/later-project");
  assert.equal(f.active, "/later-project");
  assert.deepEqual(f.opened, ["/later-project"]);
});
