import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Script, createContext } from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";

const repo = resolve(import.meta.dirname, "../../..");
const result = await build({
  entryPoints: [resolve(repo, "packages/desktop/src/main/databaseStartupRelay.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "relay-test-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /^(electron|\.\/databaseStartupTelemetry\.js)$/ }, (args) => ({
          path: args.path,
          namespace: "boundary",
        }));
        builder.onLoad({ filter: /.*/, namespace: "boundary" }, (args) => ({
          contents:
            args.path === "electron"
              ? "export const ipcMain = globalThis.fixture.ipcMain;"
              : "export const reportDatabaseStartupState = state => globalThis.fixture.telemetry.push(state);",
          loader: "js",
        }));
      },
    },
  ],
});

function fixture() {
  const ipcMain = new EventEmitter(),
    win = new EventEmitter(),
    child = new EventEmitter();
  const sent = [],
    posts = [],
    telemetry = [];
  const frame = {
    dead: false,
    detached: false,
    isDestroyed() {
      return this.dead;
    },
    send(channel, state) {
      assert.ok(!this.dead && !this.detached, "cannot send into retired frame");
      sent.push({ channel, state });
    },
  };
  win.isDestroyed = () => false;
  win.webContents = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: (...args) => frame.send(...args),
  };
  child.postMessage = (value) => posts.push(value);
  const module = { exports: {} };
  new Script(result.outputFiles[0].text).runInContext(
    createContext({
      module,
      exports: module.exports,
      require: createRequire(import.meta.url),
      fixture: { ipcMain, telemetry },
      console,
      Buffer,
      URL,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
    }),
  );
  const relay = module.exports.bindDatabaseStartupRelay(win, child, "owned-startup");
  const ready = {
    schemaVersion: 1,
    startupId: relay.startupId,
    attemptId: "attempt",
    sequence: 1,
    startedAt: 1,
    updatedAt: 2,
    phase: "ready",
    disk: [],
  };
  return { ipcMain, win, child, frame, sent, posts, telemetry, relay, ready, api: module.exports };
}

for (const retired of ["dead", "detached"]) {
  test(`retired ${retired} frame suppresses delivery but snapshot retains Host exit failure`, () => {
    const f = fixture();
    f.relay.receive(f.ready);
    assert.equal(f.sent.length, 1);
    f.frame[retired] = true;
    assert.doesNotThrow(() => f.child.emit("exit", 0));
    assert.equal(f.sent.length, 1);
    assert.equal(f.telemetry.at(-1).phase, "failed");
    f.frame[retired] = false;
    const channel = f.ipcMain.eventNames()[0];
    f.ipcMain.emit(channel, { sender: f.win.webContents }, { action: "snapshot" });
    assert.equal(f.sent.at(-1).state.phase, "failed");
    assert.equal(f.sent.at(-1).state.errorCode, "transport_closed");
    assert.equal(f.posts.length, 0);
    f.win.emit("closed");
    assert.equal(f.ipcMain.listenerCount(channel), 0);
  });
}

test("live relay keeps startup identity, sequence, sender and replacement fences", () => {
  const f = fixture();
  f.relay.receive(f.ready);
  f.relay.receive({ ...f.ready, startupId: "foreign", sequence: 9 });
  f.relay.receive({ ...f.ready, sequence: 0 });
  assert.equal(f.sent.length, 1);
  f.ipcMain.emit(f.ipcMain.eventNames()[0], { sender: {} }, { action: "snapshot" });
  assert.equal(f.sent.length, 1);
  const replacement = new EventEmitter();
  replacement.postMessage = () => {};
  const next = f.api.bindDatabaseStartupRelay(f.win, replacement, "next-startup");
  f.child.emit("exit", 1);
  f.relay.receive({ ...f.ready, sequence: 3 });
  assert.equal(f.sent.length, 1);
  next.receive({ ...f.ready, startupId: next.startupId });
  assert.equal(f.sent.length, 2);
  f.win.emit("closed");
  assert.equal(replacement.listenerCount("exit"), 0);
});
