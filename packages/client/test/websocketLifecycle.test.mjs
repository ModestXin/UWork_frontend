import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const clientRoot = resolve(import.meta.dirname, "../../..");
const home = await mkdtemp(join(tmpdir(), "uwork-websocket-lifecycle-"));
assert.equal(typeof globalThis.WebSocket, "function");
const nativeWebSocket = globalThis.WebSocket;
const source = (path) => import(pathToFileURL(join(clientRoot, path)).href);
const { ChannelServer, Emitter, ProxyChannel, SocketProtocol, VSBuffer } = await source(
  "packages/rpc/src/index.ts",
);
const { connectViaWebSocket } = await source("packages/client/src/websocket.ts");
const { RemoteServiceAccess } = await source("packages/client/src/remoteServiceAccess.ts");
const { IFileService } = await source("packages/services/src/index.ts");
const requireFromServer = createRequire(join(clientRoot, "packages/server/package.json"));
const { WebSocketServer } = requireFromServer("ws");
assert.equal(
  typeof WebSocketServer,
  "function",
  "installed ws server constructor must be available",
);
const results = [];
const OBSERVE_MS = 150;
const PHASE_MS = 1500;

async function bounded(promise, milliseconds = PHASE_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("W02_PHASE_TIMEOUT")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function track(promise) {
  const result = { state: "pending" };
  void promise.then(
    () => {
      result.state = "resolved";
    },
    () => {
      result.state = "rejected";
    },
  );
  return result;
}

function wrapServerSocket(socket) {
  const onData = new Emitter(),
    onClose = new Emitter(),
    onEnd = new Emitter();
  socket.on("message", (data) => onData.fire(VSBuffer.wrap(new Uint8Array(data))));
  socket.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write: (buffer) => {
      if (socket.readyState === 1) socket.send(buffer.buffer);
    },
    end: () => socket.close(),
    drain: async () => {},
    dispose: () => socket.close(),
  };
}

async function portClosed(port) {
  const socket = createConnection({ host: "127.0.0.1", port });
  return bounded(
    new Promise((resolvePort) => {
      socket.once("connect", () => {
        socket.destroy();
        resolvePort(false);
      });
      socket.once("error", (error) => {
        socket.destroy();
        resolvePort(error.code === "ECONNREFUSED");
      });
    }),
  ).finally(() => socket.destroy());
}

async function runCase(queued, errorFirst = false) {
  const name = errorFirst
    ? "error-then-close"
    : queued
      ? "initialize-queued"
      : "initialized-inflight";
  const directory = join(home, name);
  await mkdir(directory, { mode: 0o700 });
  const seed = join(directory, "seed.txt");
  const marker = "OWNED_W02_RPC_BASELINE\n";
  await writeFile(seed, marker, { flag: "wx", mode: 0o600 });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let peer, channel, protocol, browserSocket, release, heldRead, closedPromiseResolve;
  let calls = 0,
    closedCount = 0,
    openedCount = 0,
    entered,
    actualClose,
    notifiedClose;
  const enteredPromise = new Promise((done) => {
    entered = done;
  });
  const closedPromise = new Promise((done) => {
    closedPromiseResolve = done;
  });
  server.on("connection", (socket) => {
    peer = socket;
    protocol = new SocketProtocol(wrapServerSocket(socket));
    channel = new ChannelServer(protocol, "owned-w02", 1000, true);
    channel.registerChannel(
      IFileService.channelName,
      ProxyChannel.fromService({
        readTextFile(input) {
          assert.deepEqual(input, { path: seed });
          calls++;
          const task = (async () => {
            if (calls === 2) {
              entered();
              await new Promise((finish) => {
                release = finish;
              });
            }
            return { content: await readFile(seed, "utf8") };
          })();
          if (calls === 2) heldRead = task;
          return task;
        },
      }),
    );
  });
  const fact = {
    name,
    nativeWebSocket: false,
    remoteServiceAccess: false,
    openCount: 0,
    closePayloadMatchesActual: false,
    listenersReleased: false,
    initializedBaseline: false,
    serverCallsBeforeClose: null,
    serverCallsAfterClose: null,
    inFlight: "not-started",
    afterClose: "not-started",
    closeCount: 0,
    serverClosed: false,
    exactPortClosed: false,
    seedRemoved: false,
    modelRequests: 0,
    setupFailure: false,
  };
  let port;
  try {
    await bounded(once(server, "listening"));
    port = server.address().port;
    const services = await bounded(
      connectViaWebSocket(`ws://127.0.0.1:${port}`, {
        onOpenSocket: (socket) => {
          browserSocket = socket;
          openedCount++;
          socket.addEventListener(
            "close",
            (event) => {
              actualClose = { code: event.code, reason: event.reason, wasClean: event.wasClean };
            },
            { once: true },
          );
        },
        onClose: (event) => {
          notifiedClose = event;
          closedCount++;
          closedPromiseResolve();
        },
      }),
    );
    fact.nativeWebSocket = browserSocket instanceof nativeWebSocket;
    fact.remoteServiceAccess = services instanceof RemoteServiceAccess;
    assert.ok(peer && channel && protocol);
    if (!queued) {
      channel.ready();
      const baseline = await bounded(services.fileService.readTextFile({ path: seed }));
      fact.initializedBaseline = baseline.content === marker;
    }
    const pending = track(services.fileService.readTextFile({ path: seed }));
    if (!queued) await bounded(enteredPromise);
    fact.serverCallsBeforeClose = calls;
    if (errorFirst) browserSocket.dispatchEvent(new Event("error"));
    peer.terminate();
    await bounded(closedPromise);
    const afterClose = track(services.fileService.readTextFile({ path: seed }));
    await new Promise((done) => setTimeout(done, OBSERVE_MS));
    fact.inFlight = pending.state;
    fact.afterClose = afterClose.state;
    fact.serverCallsAfterClose = calls;
    fact.closeCount = closedCount;
    fact.openCount = openedCount;
    fact.closePayloadMatchesActual = JSON.stringify(notifiedClose) === JSON.stringify(actualClose);
    fact.listenersReleased = ["open", "error", "close", "message"].every(
      (event) => getEventListeners(browserSocket, event).length === 0,
    );
  } catch {
    fact.setupFailure = true;
  } finally {
    release?.();
    channel?.dispose();
    protocol?.dispose();
    if (peer?.readyState !== 3) peer?.terminate();
    if (browserSocket?.readyState !== 3) browserSocket?.close();
    try {
      if (heldRead) await bounded(heldRead);
      await bounded(
        new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      );
      fact.serverClosed = server.address() === null;
      fact.exactPortClosed = Number.isInteger(port) && (await portClosed(port));
      if (fact.serverClosed && fact.exactPortClosed) {
        await rm(directory, { recursive: true });
        fact.seedRemoved = true;
      }
    } catch {
      fact.setupFailure = true;
    }
    results.push(fact);
  }
  return fact;
}

for (const [queued, errorFirst] of [
  [false, false],
  [true, false],
  [false, true],
]) {
  test(
    errorFirst
      ? "error disposes RPC but preserves the subsequent actual CloseEvent once"
      : queued
        ? "native WebSocket close rejects RPC queued before Initialize"
        : "native WebSocket close rejects initialized in-flight RPC",
    { timeout: 4000 },
    async () => {
      const fact = await runCase(queued, errorFirst);
      assert.equal(fact.setupFailure, false, "setup and owned cleanup must complete");
      assert.equal(fact.nativeWebSocket, true);
      assert.equal(fact.remoteServiceAccess, true);
      assert.equal(fact.serverCallsBeforeClose, queued ? 0 : 2);
      assert.equal(fact.serverCallsAfterClose, queued ? 0 : 2);
      assert.equal(fact.initializedBaseline, !queued);
      assert.equal(fact.closeCount, 1);
      assert.equal(fact.openCount, 1);
      assert.equal(fact.closePayloadMatchesActual, true);
      assert.equal(fact.listenersReleased, true);
      assert.equal(fact.serverClosed && fact.exactPortClosed && fact.seedRemoved, true);
      assert.deepEqual(
        { inFlight: fact.inFlight, afterClose: fact.afterClose },
        {
          inFlight: "rejected",
          afterClose: "rejected",
        },
      );
    },
  );
}

after(async () => {
  if (
    results.length === 3 &&
    results.every((fact) => fact.serverClosed && fact.exactPortClosed && fact.seedRemoved)
  )
    await rm(home, { recursive: true });
});
