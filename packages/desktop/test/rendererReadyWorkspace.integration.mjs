// 执行现有跨层源码，仅替换 Electron、React 调度及无关 UI/遥测边界。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { after, test } from "node:test";
import { createContext, Script } from "node:vm";
import { build } from "esbuild";

const repo = resolve(import.meta.dirname, "../../..");
const workspace = await mkdtemp(join(repo, ".renderer-ready-test-"));
after(() => rm(workspace, { recursive: true, force: true }));
const stubs = new Map([
  [
    "electron",
    `export const { app, BrowserWindow, dialog, ipcMain, ipcRenderer, shell, contextBridge, webFrame, webUtils } = globalThis.fixture.electron;`,
  ],
  [
    "react",
    `export const useEffect = fn => globalThis.fixture.effects.push(fn); export const useRef = current => ({current}); export const useState = value => [value, () => {}];`,
  ],
  ["@zcode/ui", `export const recordArmsCustomEventForE2E = () => {};`],
  ["@arms/rum-electron", `export default {sendCustom() {}};`],
  ["@/logger.js", `export const logger = globalThis.fixture.logger;`],
  [
    "@/store/zcodeSessionStore.js",
    `export const useZCodeSessionStore = {getState: () => ({workspaces: {}}), subscribe: () => () => {}};`,
  ],
  ["@/store/tabStore.js", `export const isWorkspaceTab = tab => tab.kind === 'workspace';`],
  [
    "@/store/TabStoreProvider.js",
    `export const useTabStore = select => select({activeTabId: null, tabs: []});`,
  ],
  ["@/v4/composer/newTaskDraft.js", `export const seedImportedSessionDraft = () => {};`],
  [
    "@/components/ui/toast.js",
    `export const dismissToast = () => {}; export const toast = () => 1; export const updateToast = () => {};`,
  ],
  ["@/lib/keyboardShortcuts.js", `export const matchesPrimaryShortcut = () => false;`],
  ["@/shortcuts/bindings.js", `export const isShortcutRecordingActive = () => false;`],
  ["@/lib/rendererNavigation.js", `export const isRendererReloadNavigation = () => false;`],
  [
    "@/hooks/useWorkspaceServices.js",
    `export const useOptionalBaseWorkspaceServices = () => null;`,
  ],
  ["desktopNotifications.js", `export const dispatchTaskNotification = () => {};`],
  [
    "desktopArmsCustomEvent.js",
    `export const dispatchFinalArmsCustomEvent = () => {}; export const enableSharedFinalArmsCustomEventE2EController = () => {};`,
  ],
  [
    "desktopRemoteUsageArmsTelemetry.js",
    `export const configureRemoteUsageArmsTelemetry = () => {}; export const reportRemoteConnectResultToArms = () => {};`,
  ],
  ["desktopMainIpcHelpers.js", `export const openPathInDefaultApp = () => {};`],
  [
    "enterpriseLoginView.js",
    `export const openEnterpriseLoginView = () => {}; export const cancelEnterpriseLoginView = () => {}; export const updateEnterpriseLoginView = () => {};`,
  ],
]);
const bundled = await build({
  stdin: {
    contents: `
      import './packages/desktop/src/preload/index.ts';
      export {useRootPlatformEffects} from './packages/ui/src/root/useRootPlatformEffects.ts';
      export {createDesktopPlatform} from './packages/desktop/src/renderer/src/desktopPlatform.ts';
      export {registerRemoteIpcHandlers} from './packages/desktop/src/main/desktopMainIpcRemote.ts';
      export {handleOpenWorkspacePath} from './packages/desktop/src/main/desktopOAuthDeepLink.ts';
      export {handleSecondInstanceWorkspaceRequest} from './packages/desktop/src/main/desktopSecondInstanceDeepLink.ts';
      export {PlatformChannels} from '@zcode/shared';`,
    resolveDir: repo,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "renderer-ready-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          const key = stubs.has(args.path) ? args.path : basename(args.path);
          if (stubs.has(key)) return { path: key, namespace: "boundary" };
          if (args.path.startsWith("@/root/"))
            return {
              path: join(repo, "packages/ui/src", args.path.slice(2).replace(/\.js$/, ".ts")),
            };
          if (args.path === "@zcode/shared")
            return { path: join(repo, "packages/shared/src/index.ts") };
        });
        builder.onLoad({ filter: /.*/, namespace: "boundary" }, (args) => ({
          contents: stubs.get(args.path),
          loader: "js",
        }));
      },
    },
  ],
});

function createFixture(platformName = "darwin") {
  const rendererId = 1;
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const ipcRenderer = new EventEmitter();
  const app = new EventEmitter();
  app.show = () => {};
  const opened = [],
    warnings = [],
    deliveries = [],
    effects = [],
    ready = [];
  const logger = {
    info() {},
    warn: (...args) => warnings.push(args),
    error: (...args) => warnings.push(args),
  };
  const makeWindow = (id) => {
    const win = new EventEmitter();
    Object.assign(win, {
      webContents: {
        id,
        send(channel, ...args) {
          deliveries.push({ id, channel, args });
          if (id === rendererId) ipcRenderer.emit(channel, {}, ...args);
        },
      },
      isMinimized: () => false,
      isVisible: () => true,
      focus() {},
      show() {},
      restore() {},
    });
    return win;
  };
  const win = makeWindow(rendererId);
  const fakeWindow = {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    ArmsEventBridge: { send() {} },
  };
  const fixture = {
    effects,
    logger,
    electron: {
      app,
      ipcMain,
      ipcRenderer,
      BrowserWindow: {
        getFocusedWindow: () => win,
        getAllWindows: () => [win],
        fromWebContents: () => win,
      },
      contextBridge: {
        exposeInMainWorld: (key, value) => {
          fakeWindow[key] = value;
        },
      },
      webFrame: { getZoomFactor: () => 1 },
      webUtils: {},
      dialog: {},
      shell: {},
    },
  };
  let api;
  ipcRenderer.send = (channel, ...args) => {
    if (channel === api?.PlatformChannels.RendererReady) {
      // 最末端订阅已经建立，不能提前放开 Main pending。
      for (const event of ["FocusTab", "NewTab", "NewTask", "OpenWorkspace", "UpdateCheckResult"])
        assert.equal(ipcRenderer.listenerCount(api.PlatformChannels[event]), 1, event);
      ready.push(rendererId);
    }
    ipcMain.emit(channel, { sender: win.webContents }, ...args);
  };
  ipcRenderer.invoke = async () => undefined;
  const module = { exports: {} };
  const context = createContext({
    fixture,
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    window: fakeWindow,
    document: { title: "ready fixture" },
    URL,
    console,
    process: {
      env: {},
      argv: [],
      platform: platformName,
      title: "fixture",
      execPath: process.execPath,
    },
    setTimeout,
    clearTimeout,
  });
  new Script(bundled.outputFiles[0].text, { filename: "renderer-ready-source.cjs" }).runInContext(
    context,
  );
  api = module.exports;
  api.registerRemoteIpcHandlers({
    logger,
    appTelemetryRuntime: { onRendererReady() {} },
    armsCustomContext: {},
  });
  app.emit("browser-window-created", {}, win);
  const platform = api.createDesktopPlatform({ isLocalDevelopmentRuntime: false });
  function request(path = workspace, target = win) {
    return api.handleSecondInstanceWorkspaceRequest({
      argv: ["uwork", "--open-workspace", path],
      additionalData: {},
      handleDeepLink: () => false,
      handleOpenWorkspacePath: (value, options) =>
        api.handleOpenWorkspacePath(value, logger, options),
      resolveApplicationWindow: () => target,
    });
  }
  function mount(options = {}) {
    effects.length = 0;
    api.useRootPlatformEffects({
      platform,
      tabs: [],
      locale: "en-US",
      totalUnreadTaskCount: 0,
      // 该组默认覆盖已完成初始恢复后的真实 ready IPC；held restore 由下方独立用例覆盖。
      canBootstrapInitialWorkspace: true,
      isDesktop: true,
      addTab() {},
      setIsBootstrappingInitialWorkspace() {},
      activateTabByPath: () => false,
      startDraftInWorkspace() {},
      startNewTaskFromActiveWorkspace() {},
      openWorkspace() {},
      openWorkspacePath: (path) => opened.push(path),
      setWorkspaceActionError() {},
      intl: { formatMessage: (value) => value.id },
      isRestoringOAuthSession: false,
      ...options,
    });
    const cleanup = effects
      .map((effect) => effect())
      .filter((value) => typeof value === "function");
    return () => cleanup.forEach((dispose) => dispose());
  }
  return {
    api,
    platform,
    opened,
    warnings,
    deliveries,
    ready,
    win,
    makeWindow,
    ipcMain,
    ipcRenderer,
    request,
    mount,
  };
}

const flush = () => new Promise((resolveFlush) => setImmediate(resolveFlush));

test("Main retains an explicit request until initial restore permits ready IPC", async () => {
  const f = createFixture();
  f.request();
  const held = f.mount({ canBootstrapInitialWorkspace: false });
  await flush();
  assert.deepEqual(f.ready, []);
  assert.deepEqual(f.opened, []);
  held();
  const dispose = f.mount({ canBootstrapInitialWorkspace: true });
  await flush();
  assert.deepEqual(f.ready, [1]);
  assert.deepEqual(f.opened, [workspace]);
  dispose();
});

for (const os of ["darwin", "win32", "linux"])
  test(`${os}: running-window argv is cached before listeners, then delivered once through the real ready IPC`, async () => {
    const f = createFixture(os);
    assert.equal(f.request(), true);
    assert.equal(f.deliveries.length, 0);
    assert.ok(f.warnings.some((args) => String(args[0]).includes("先缓存等待 renderer ready")));
    const dispose = f.mount();
    assert.deepEqual(f.opened, []);
    await flush();
    assert.deepEqual(f.opened, [workspace]);
    assert.deepEqual(f.ready, [1]);
    dispose();
    const disposeAgain = f.mount();
    await flush();
    assert.deepEqual(f.opened, [workspace]);
    assert.deepEqual(f.ready, [1, 1]);
    // 已 ready 的 second-instance 继续走原实时投递，不重复消费旧缓存。
    assert.equal(f.request(), true);
    assert.deepEqual(f.opened, [workspace, workspace]);
    disposeAgain();
  });

test("StrictMode setup/cleanup/setup cancels the stale notification and only the live subscription consumes pending", async () => {
  const f = createFixture();
  f.request();
  f.mount()();
  const dispose = f.mount();
  await flush();
  assert.deepEqual(f.ready, [1]);
  assert.deepEqual(f.opened, [workspace]);
  dispose();
  assert.equal(f.ipcRenderer.listenerCount(f.api.PlatformChannels.NewTab), 0);
});

test("unmount before notification preserves Main pending for the next live subscription", async () => {
  const f = createFixture();
  f.request();
  f.mount()();
  await flush();
  assert.deepEqual(f.ready, []);
  assert.deepEqual(f.opened, []);
  const dispose = f.mount();
  await flush();
  assert.deepEqual(f.opened, [workspace]);
  dispose();
});

for (const mode of ["throw", "reject"])
  test(`${mode}: ready failure is logged, listeners clean up, and the next subscription can deliver pending`, async () => {
    const f = createFixture();
    const original = f.platform.notifyRendererReady;
    f.platform.notifyRendererReady = () => {
      if (mode === "throw") throw new Error("fixture ready failure");
      return Promise.reject(new Error("fixture ready failure"));
    };
    f.request();
    const dispose = f.mount();
    await flush();
    assert.deepEqual(f.opened, []);
    assert.ok(f.warnings.some((args) => String(args[0]).includes("通知 renderer ready 失败")));
    dispose();
    assert.equal(f.ipcRenderer.listenerCount(f.api.PlatformChannels.NewTab), 0);
    f.platform.notifyRendererReady = original;
    const disposeAgain = f.mount();
    await flush();
    assert.deepEqual(f.opened, [workspace]);
    disposeAgain();
  });

test("pending remains bound to its window, and the real closed handler removes stale delivery", async () => {
  const f = createFixture();
  f.request();
  const other = f.makeWindow(2);
  f.ipcMain.emit(f.api.PlatformChannels.RendererReady, { sender: other.webContents });
  assert.deepEqual(f.deliveries, []);
  f.win.emit("closed");
  const dispose = f.mount();
  await flush();
  assert.deepEqual(f.opened, []);
  dispose();
});

test("shared Root with the default non-desktop flag accepts a no-op ready port and cleans up normally", async () => {
  const f = createFixture();
  let notifications = 0;
  const platform = {
    ...f.platform,
    notifyRendererReady: () => {
      notifications += 1;
    },
  };
  const dispose = f.mount({ platform, isDesktop: undefined });
  await flush();
  assert.equal(notifications, 1);
  assert.deepEqual(f.ready, []);
  dispose();
  assert.equal(f.ipcRenderer.listenerCount(f.api.PlatformChannels.NewTab), 0);
});
