// 执行真实协议与冷启动 gate 源码；只控制 Electron 对话框和文件系统边界，不冒充原生 OS 验收。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createContext, Script } from "node:vm";
import { build } from "esbuild";

const repo = resolve(import.meta.dirname, "../../..");
const bundled = await build({
  stdin: {
    contents: `export {confirmExternalWorkspaceOpen, handleDeepLink, handleOpenWorkspacePath, deliverPendingDeepLink} from './packages/desktop/src/main/desktopOAuthDeepLink.ts';
      export {resolveExplicitStartupWorkspaceBootstrap} from './packages/desktop/src/main/startupWorkspaceDeepLinkGate.ts';
      export {createDeepLinkSingleInstanceData} from './packages/desktop/src/main/desktopDeepLinkUrl.ts';
      export {handleSecondInstanceWorkspaceRequest} from './packages/desktop/src/main/desktopSecondInstanceDeepLink.ts';`,
    resolveDir: repo,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "owned-native-confirmation-boundaries",
      setup(builder) {
        const stubs = new Map([
          ["electron", `export const {app, BrowserWindow, dialog} = globalThis.fixture.electron;`],
          [
            "node:fs",
            `export const statSync = path => globalThis.fixture.stat(path); export const constants = {};`,
          ],
          [
            "@zcode/shared",
            `export const PlatformChannels = {OpenWorkspacePath:'open-workspace', OAuthCallback:'oauth', PaymentCallback:'payment', ShareImport:'share'};
          export const appSettingsSchema = {}; export const formatZodError = () => ''; export const resolveStartupLocalWorkspaceSessionIndex = () => 0;`,
          ],
        ]);
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (stubs.has(args.path)) return { path: args.path, namespace: "confirmation-boundary" };
          if (args.path.endsWith("desktopLinuxDeepLinkRegistration.js"))
            return { path: "registration", namespace: "confirmation-boundary" };
        });
        builder.onLoad({ filter: /.*/, namespace: "confirmation-boundary" }, (args) => ({
          contents:
            args.path === "registration"
              ? `export const registerLinuxDeepLinkProtocol = () => { throw new Error('Registration is outside this confirmation test'); };`
              : stubs.get(args.path),
          loader: "js",
        }));
      },
    },
  ],
});

const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));
export async function flush() {
  await tick();
  await tick();
}
export function fixture() {
  const calls = [],
    stats = [],
    sent = [],
    warnings = [],
    syncCalls = [];
  const state = { active: true, focused: null };
  let nextId = 0;
  function window() {
    const win = new EventEmitter();
    win.id = ++nextId;
    win.destroyed = false;
    win.contentsDestroyed = false;
    win.isDestroyed = () => win.destroyed;
    win.isMinimized = () => false;
    win.isVisible = () => true;
    win.focus = () => {};
    win.webContents = {
      id: win.id,
      isDestroyed: () => win.contentsDestroyed,
      send: (channel, value) => sent.push({ windowId: win.id, channel, value }),
    };
    return win;
  }
  const win = window();
  state.focused = win;
  const logger = {
    info() {},
    warn(...args) {
      warnings.push(args);
    },
  };
  const native = {
    app: { show() {} },
    BrowserWindow: {
      getFocusedWindow: () => state.focused,
      getAllWindows: () => (state.focused ? [state.focused] : []),
    },
    dialog: {
      showMessageBox(...args) {
        let accept, reject;
        const promise = new Promise((resolveDialog, rejectDialog) => {
          accept = resolveDialog;
          reject = rejectDialog;
        });
        calls.push({
          parent: args.length === 2 ? args[0] : null,
          options: args.at(-1),
          accept,
          reject,
        });
        return promise;
      },
      showMessageBoxSync(...args) {
        syncCalls.push(args);
        return 1;
      },
    },
  };
  const module = { exports: {} };
  const context = createContext({
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    URL,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    AbortController,
    process: { platform: "linux", env: {}, argv: [], execPath: process.execPath },
    fixture: {
      electron: native,
      stat(path) {
        stats.push(path);
        return { isDirectory: () => path !== "/missing" };
      },
    },
  });
  new Script(bundled.outputFiles[0].text, {
    filename: "real-external-workspace-source.cjs",
  }).runInContext(context);
  const api = module.exports;
  api.deliverPendingDeepLink(win.webContents);
  function request(path, extra = {}) {
    return api.handleDeepLink(`zcode://workspace/open?path=${encodeURIComponent(path)}`, logger, {
      resolveApplicationWindow: () => state.focused,
      isRequestActive: () => state.active,
      ...extra,
    });
  }
  return { api, win, window, state, calls, stats, sent, warnings, syncCalls, logger, request };
}
export async function dialog(f, ordinal = 0) {
  await flush();
  assert.equal(f.syncCalls.length, 0, "External confirmation must not block the native process");
  assert.ok(f.calls[ordinal], "Original async native dialog must be pending");
  return f.calls[ordinal];
}
export const opened = (f) => f.sent.filter((row) => row.channel === "open-workspace");

export function requestWire(f, path) {
  const url = `zcode://workspace/open?path=${encodeURIComponent(path)}&wireLabel=中文`;
  const additionalData = f.api.createDeepLinkSingleInstanceData(["app", url]);
  assert.notEqual(additionalData.deepLinkUrl, url, "组合 gate 必须实际经过 non-ASCII wire");
  return f.api.handleSecondInstanceWorkspaceRequest({
    additionalData,
    argv: ["app"],
    resolveApplicationWindow: () => f.win,
    handleDeepLink: (value, options) =>
      f.api.handleDeepLink(value, f.logger, {
        ...options,
        isRequestActive: () => f.state.active,
      }),
    handleOpenWorkspacePath: () => assert.fail("Wire URI must not bypass external confirmation"),
  });
}
