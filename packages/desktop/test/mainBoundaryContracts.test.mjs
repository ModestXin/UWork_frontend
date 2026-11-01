import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../../..");
const bundle = await build({
  stdin: {
    contents: `
    export {createDesktopTelemetryFetch} from './packages/desktop/src/main/desktopTelemetryFetch.ts';
    export {registerDesktopPrintToPdfIpcHandler} from './packages/desktop/src/main/desktopPrintToPdf.ts';
    export {registerDesktopSaveFileIpcHandler} from './packages/desktop/src/main/desktopSaveFile.ts';
    export {ManifestUpdateProvider} from './packages/desktop/src/main/manifestUpdateProvider.ts';
    export {TaskRealtimeBus} from './packages/desktop/src/main/taskRealtimeBus.ts';
    export {PlatformChannels, taskRealtimeDeliveredEventSchema} from '@zcode/shared';`,
    resolveDir: root,
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  // 真实网络/文件及 updater parser 不替换；只替换 Electron 外壳和 Provider HTTP 输入。
  external: ["undici", "electron-updater/out/providers/Provider.js"],
  plugins: [
    {
      name: "main-boundaries",
      setup(b) {
        b.onResolve({ filter: /^@zcode\/shared$/ }, () => ({
          path: join(root, "packages/shared/src/index.ts"),
        }));
        b.onResolve({ filter: /^(electron|electron-updater|\.\/logger\.js)$/ }, (args) => ({
          path: args.path,
          namespace: "boundary",
        }));
        b.onLoad({ filter: /.*/, namespace: "boundary" }, (args) => ({
          loader: "js",
          contents:
            args.path === "electron"
              ? "export const {ipcMain,dialog,BrowserWindow}=globalThis.fixture;"
              : args.path === "electron-updater"
                ? `export class Provider {async httpRequest(){return globalThis.fixture.rawManifest;}}; export class AppImageUpdater{};export class DebUpdater{};export class RpmUpdater{};export class PacmanUpdater{};`
                : "export const logger={info(){},warn(){}};",
        }));
      },
    },
  ],
});

function fixture() {
  const handlers = new Map();
  const f = {
    rawManifest: "",
    dialogCalls: 0,
    savePath: undefined,
    ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
    dialog: {
      async showSaveDialog() {
        f.dialogCalls++;
        return f.savePath ? { canceled: false, filePath: f.savePath } : { canceled: true };
      },
    },
    BrowserWindow: { fromWebContents: () => null },
  };
  const module = { exports: {} };
  new Script(bundle.outputFiles[0].text).runInContext(
    createContext({
      module,
      exports: module.exports,
      require: createRequire(import.meta.url),
      fixture: f,
      console,
      Buffer,
      URL,
      Request,
      Response,
      Headers,
      ArrayBuffer,
      SharedArrayBuffer,
      Uint8Array,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      process,
      structuredClone,
    }),
  );
  return { f, handlers, api: module.exports };
}

test("Electron telemetry accepts URL input without changing Request bodies or receiver", async () => {
  const seen = [];
  const source = {
    async fetch(input, init) {
      assert.equal(this, source);
      seen.push({ input, init });
      return new Response("ok");
    },
  };
  const { api } = fixture();
  const fetch = api.createDesktopTelemetryFetch(source);
  await fetch(new URL("https://example.invalid/metrics"), { method: "POST", body: "owned" });
  assert.equal(seen[0].input, "https://example.invalid/metrics");
  assert.equal(seen[0].init.body, "owned");
  const request = new Request("https://example.invalid/metrics");
  await fetch(request);
  assert.equal(seen[1].input, request);
});

test("PDF IPC copies only the Buffer view into an independent transferable ArrayBuffer", async () => {
  const { api, handlers } = fixture();
  api.registerDesktopPrintToPdfIpcHandler({ warn() {} });
  const backing = Buffer.from([99, 1, 2, 3, 88]);
  const view = backing.subarray(1, 4);
  const result = await handlers.get(api.PlatformChannels.PrintToPdf)({
    sender: { id: 1, printToPDF: async () => view },
  });
  assert.equal(result.success, true);
  assert.ok(result.data instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(result.data)], [1, 2, 3]);
  backing.fill(0);
  assert.deepEqual([...new Uint8Array(result.data)], [1, 2, 3]);
});

test("SaveFile keeps invalid and empty data out of the dialog and writes owned bytes only", async (t) => {
  const { api, f, handlers } = fixture();
  api.registerDesktopSaveFileIpcHandler({ warn() {} });
  const save = handlers.get(api.PlatformChannels.SaveFile),
    event = { sender: {} };
  for (const data of [undefined, new ArrayBuffer(0), "invalid"]) {
    assert.equal(
      (await save(event, { suggestedName: "owned.txt", data })).error,
      "invalid_file_payload",
    );
  }
  assert.equal(f.dialogCalls, 0);
  const dir = await mkdtemp(join(tmpdir(), "uwork-main-boundary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  f.savePath = join(dir, "owned.txt");
  const data = new TextEncoder().encode("owned bytes").buffer;
  assert.equal((await save(event, { suggestedName: "owned.txt", data })).success, true);
  assert.equal(await readFile(f.savePath, "utf8"), "owned bytes");
});

test("manifest parser retains current and legacy artifact fields and request release channel", async () => {
  const { api, f } = fixture();
  const provider = new api.ManifestUpdateProvider(
    {
      provider: "custom",
      endpointOrigin: "https://example.invalid",
      releasePlatform: "darwin-aarch64",
      releaseChannel: "preview",
    },
    {},
    {},
  );
  for (const manifest of [
    'version: 1.2.3\nfiles:\n  - url: app.zip\n    sha512: owned-checksum\nreleaseDate: "2026-10-21"\n',
    'version: 1.2.3\npath: app.zip\nsha512: owned-checksum\nreleaseDate: "2026-10-21"\n',
  ]) {
    f.rawManifest = manifest;
    const info = await provider.getLatestVersion();
    assert.equal(info.version, "1.2.3");
    assert.equal(info.zcodeReleaseChannel, "preview");
    const files = provider.resolveFiles(info);
    assert.equal(files.length, 1);
    assert.equal(files[0].url.href, "https://example.invalid/app.zip");
    assert.equal(files[0].info.sha512, "owned-checksum");
  }
  f.rawManifest = "files: []";
  await assert.rejects(() => provider.getLatestVersion(), /Invalid electron update manifest/);
});

for (const deliveryKind of ["desktop_window", "relay_bridge"]) {
  test(`${deliveryKind} wire relay preserves unknown events, text sequencing and scope fencing`, () => {
    const { api } = fixture();
    const bus = new api.TaskRealtimeBus({ logger: { info() {}, warn() {} } });
    const sent = [];
    const child = new EventEmitter();
    child.postMessage = (m) => sent.push(m);
    bus.registerHost({
      hostId: "owner",
      windowId: 1,
      child,
      workspaceKeys: ["/owned"],
      deliveryKind,
    });
    const target = {
      workspacePath: "/owned",
      workspaceKey: "/owned",
      taskId: "task",
      runId: "run",
      traceId: "run",
    };
    child.emit("message", {
      type: "task-run-lease-acquire",
      request: { ...target, leaseRequestId: "request" },
    });
    const send = (event) =>
      child.emit("message", {
        type: "task-stream-op-publish",
        target,
        op: { kind: "stream_event", event: { ...event, taskId: "task", traceId: "run" } },
      });
    send({ type: "future_event", opaque: { owned: true } });
    send({ type: "agent_message_chunk", content: "A" });
    send({ type: "agent_message_chunk", content: "B" });
    send({ type: "task_complete" });
    const messages = sent.filter((m) => m.event?.type === "task_stream_mirror_batch");
    assert.equal(messages.length, 1);
    const event = messages[0].event;
    assert.equal(api.taskRealtimeDeliveredEventSchema.safeParse(event).success, true);
    assert.equal(event.ops.length, 3);
    assert.equal(event.ops[1].event.content, "AB");
    assert.deepEqual(
      Array.from(event.ops, (o) => o.seq),
      [1, 2, 3],
    );
    assert.equal(event.ops[0].event.opaque.owned, true);
    const count = sent.length;
    send({ type: "agent_message_chunk", content: "after-terminal" });
    assert.equal(sent.length, count);
    bus.unregisterHost("owner");
  });
}
