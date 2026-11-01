import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { retireRoots, within } from "./runnerSafety.mjs";

const source = await readFile(new URL("../enterpriseLoginError.e2e.mjs", import.meta.url), "utf8");
const start = source.indexOf("  let serverCloseCompleted = false;");
const end = source.indexOf("  for (const row of [...children.values()].reverse())", start);
const gateStart = source.indexOf("  const allClosed =");
const gateEnd = source.indexOf("  const rootFds =", gateStart);
assert.ok(start >= 0 && end > start && gateStart > end && gateEnd > gateStart);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction(
  "within",
  "server",
  "browser",
  "chrome",
  "trackingError",
  "daemon",
  "remaining",
  "tcp",
  "unixSockets",
  source.slice(start, end) +
    source.slice(gateStart, gateEnd) +
    "\nreturn { serverCloseCompleted, allClosed };",
);
const timerCount = () =>
  process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

test("full Vite close deadline and completion gate", async (t) => {
  for (const pending of [true, false]) {
    await t.test(
      pending
        ? "never-settling close reaches known-process cleanup and retains roots"
        : "resolved full close permits normal cleanup",
      { timeout: 2000 },
      async () => {
        const calls = [];
        const child = (label) => ({
          exitCode: null,
          signalCode: null,
          kill: (signal) => calls.push([label, signal]),
        });
        const server = {
          httpServer: { listening: false },
          close: () => (pending ? new Promise(() => {}) : Promise.resolve()),
        };
        const before = timerCount();
        const started = performance.now();
        const state = await run(
          (milliseconds, code, operation) => {
            assert.equal(milliseconds, 3000);
            assert.equal(code, "OWNED_VITE_CLOSE_TIMEOUT");
            return within(25, code, operation);
          },
          server,
          child("BH"),
          child("Chrome"),
          null,
          {},
          [],
          [],
          [],
        );
        assert.ok(performance.now() - started < 1000);
        assert.deepEqual(calls, [
          ["BH", "SIGTERM"],
          ["Chrome", "SIGTERM"],
        ]);
        assert.equal(state.serverCloseCompleted, !pending);
        assert.equal(
          state.allClosed,
          !pending,
          "HTTP listening=false alone must not prove full close",
        );
        const io = [];
        const roots = { scratch: "/owned/scratch", daemonHome: "/owned/daemon" };
        const result = await retireRoots(
          roots,
          {
            driverSucceeded: true,
            resourcesClosed: state.allClosed,
            rootFds: { complete: true, openFds: 0, unknownHolders: 0 },
          },
          {
            rm: async (...args) => io.push(["rm", ...args]),
            chmod: async (...args) => io.push(["chmod", ...args]),
          },
        );
        assert.equal(result.removed, !pending);
        assert.ok(io.every(([operation]) => operation === (pending ? "chmod" : "rm")));
        if (pending) assert.ok(io.every(([, , mode]) => mode === 0o700));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(timerCount(), before);
      },
    );
  }
});
