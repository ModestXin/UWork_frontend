import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import { connectViaWebSocket } from "../src/websocket.js";

const clientRoot = resolve(import.meta.dirname, "../../..");
const { WebSocketServer } = createRequire(resolve(clientRoot, "packages/server/package.json"))(
  "ws",
);
const observe = (event) => ({ code: event.code, reason: event.reason, wasClean: event.wasClean });
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("OPEN_RACE_TIMEOUT")), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const action of ["close", "error"]) {
  test(
    `onOpenSocket ${action} rejects instead of returning a dead service owner`,
    { timeout: 3000 },
    async () => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      let peer,
        socket,
        actual,
        notified,
        finishClose,
        opens = 0,
        closes = 0;
      server.on("connection", (value) => {
        peer = value;
      });
      const closed = new Promise((done) => {
        finishClose = done;
      });
      let port,
        refused = false;
      try {
        await bounded(once(server, "listening"));
        port = server.address().port;
        await assert.rejects(
          bounded(
            connectViaWebSocket(`ws://127.0.0.1:${port}`, {
              onOpenSocket(value) {
                socket = value;
                opens++;
                value.addEventListener(
                  "close",
                  (event) => {
                    actual = observe(event);
                  },
                  { once: true },
                );
                if (action === "close") value.close();
                else value.dispatchEvent(new Event("error"));
              },
              onClose(event) {
                notified = event;
                closes++;
                finishClose();
              },
            }),
          ),
        );
        await bounded(closed);
        assert.equal(opens, 1);
        assert.equal(closes, 1);
        assert.deepEqual(notified, actual);
        assert.equal(
          ["open", "close", "error", "message"].every(
            (event) => getEventListeners(socket, event).length === 0,
          ),
          true,
        );
      } finally {
        if (socket?.readyState < WebSocket.CLOSING) socket.close();
        if (peer?.readyState !== 3) peer?.terminate();
        await bounded(
          new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
        );
        const connection = createConnection({ host: "127.0.0.1", port });
        try {
          refused = await bounded(
            new Promise((done) => {
              connection.once("connect", () => done(false));
              connection.once("error", (error) => done(error.code === "ECONNREFUSED"));
            }),
          );
        } finally {
          connection.destroy();
        }
        assert.equal(refused, true);
      }
    },
  );
}
