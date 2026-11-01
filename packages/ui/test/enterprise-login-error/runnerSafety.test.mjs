import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  browserEnvironment,
  inspectRootFds,
  retireRoots,
  watchChildExit,
  within,
} from "./runnerSafety.mjs";

const roots = { scratch: "/owned/scratch", daemonHome: "/owned/daemon" };
const empty = { complete: true, openFds: 0, unknownHolders: 0 };
const timeouts = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
const immediate = () => new Promise((resolve) => setImmediate(resolve));
function ioProbe() {
  const calls = [];
  return {
    calls,
    rm: async (...args) => calls.push(["rm", ...args]),
    chmod: async (...args) => calls.push(["chmod", ...args]),
  };
}

test("child environment removes inherited CDP/cloud/debug and binds only owned local CDP", () => {
  const inherited = {
    PATH: "/synthetic/bin",
    LANG: "C",
    BU_CDP_WS: "synthetic-other",
    BU_CDP_URL: "synthetic-other",
    BU_NAME: "other",
    BU_AUTOSPAWN: "1",
    BU_BROWSER_ID: "other",
    BH_DEBUG_CLICKS: "1",
    BH_RECORD: "1",
    BH_TELEMETRY: "1",
    BH_HOME: "/other",
    BROWSER_USE_API_KEY: "synthetic-only",
    BROWSER_HARNESS_CONFIG: "/other",
    DEBUG: "*",
  };
  const env = browserEnvironment(inherited, roots, 9876);
  assert.equal(env.BU_CDP_URL, "http://127.0.0.1:9876");
  assert.equal(env.BU_NAME, "default");
  assert.deepEqual(
    Object.keys(env)
      .filter((key) => key.startsWith("BU_"))
      .sort(),
    ["BU_CDP_URL", "BU_NAME"],
  );
  assert.equal(env.BH_HOME, roots.daemonHome);
  assert.equal(env.BH_RUNTIME_DIR, roots.daemonHome + "/runtime");
  assert.equal(env.BH_RECORD, "0");
  assert.equal(env.BH_TELEMETRY, "0");
  assert.equal(env.BH_DEBUG_CLICKS, "");
  assert.equal(env.DEBUG, "");
  assert.ok(!Object.keys(env).some((key) => /^(BROWSER_USE_|BROWSER_HARNESS_)/.test(key)));
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(inherited.BU_CDP_WS, "synthetic-other");
});

test("root query is scoped to both new roots and an unknown reparented FD is aggregate-only", async () => {
  const queries = [];
  const fds = inspectRootFds(roots, new Set([100]), (command, args, options) => {
    queries.push({ command, args, options });
    return args[2] === roots.scratch
      ? { status: 0, stdout: "p901\nf7\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "" };
  });
  assert.deepEqual(
    queries.map(({ command, args }) => [command, ...args]),
    [
      ["lsof", "-nP", "+D", roots.scratch, "-Fpf"],
      ["lsof", "-nP", "+D", roots.daemonHome, "-Fpf"],
    ],
  );
  assert.ok(
    queries.every(({ options }) => options.timeout === 1000 && options.maxBuffer === 128 * 1024),
  );
  assert.equal(fds.complete, true);
  assert.equal(fds.openFds, 1);
  assert.equal(fds.unknownHolders, 1);
  assert.ok(!JSON.stringify(fds).includes("901"));
  const io = ioProbe();
  const result = await retireRoots(
    roots,
    { driverSucceeded: true, resourcesClosed: true, rootFds: fds },
    io,
  );
  assert.deepEqual(result, { removed: false, preserved: true, privateModesApplied: true });
  assert.deepEqual(io.calls, [
    ["chmod", roots.scratch, 0o700],
    ["chmod", roots.daemonHome, 0o700],
  ]);
});

test("uncertain or malformed scoped lsof retains roots without raw error/identity output", async () => {
  for (const response of [
    { status: 0, stdout: "p901\nf7\n", stderr: "synthetic-private-warning" },
    { status: null, stdout: "", stderr: "", error: Error("synthetic-private-error") },
    { status: 0, stdout: "p901\nnsensitive-name\n", stderr: "" },
    { status: 1, stdout: "p901\nf7\n", stderr: "" },
  ]) {
    const fds = inspectRootFds(roots, new Set(), () => response);
    assert.equal(fds.complete, false);
    assert.ok(!/901|private|sensitive/.test(JSON.stringify(fds)));
    const io = ioProbe();
    assert.equal(
      (await retireRoots(roots, { driverSucceeded: true, resourcesClosed: true, rootFds: fds }, io))
        .removed,
      false,
    );
    assert.ok(io.calls.every(([operation]) => operation === "chmod"));
  }
});

test("failed or timed out driver retains both roots even when all known resources closed", async () => {
  for (const driverSucceeded of [false, undefined]) {
    const io = ioProbe();
    assert.equal(
      (await retireRoots(roots, { driverSucceeded, resourcesClosed: true, rootFds: empty }, io))
        .removed,
      false,
    );
    assert.deepEqual(io.calls, [
      ["chmod", roots.scratch, 0o700],
      ["chmod", roots.daemonHome, 0o700],
    ]);
  }
});

test("deletion requires explicit driver success, closed resources, and two complete empty root queries", async () => {
  const fds = inspectRootFds(roots, new Set(), () => ({ status: 1, stdout: "", stderr: "" }));
  const io = ioProbe();
  assert.equal(
    (await retireRoots(roots, { driverSucceeded: true, resourcesClosed: true, rootFds: fds }, io))
      .removed,
    true,
  );
  assert.deepEqual(io.calls, [
    ["rm", roots.scratch, { recursive: true, force: true }],
    ["rm", roots.daemonHome, { recursive: true, force: true }],
  ]);
  const open = ioProbe();
  assert.equal(
    (
      await retireRoots(
        roots,
        { driverSucceeded: true, resourcesClosed: false, rootFds: fds },
        open,
      )
    ).removed,
    false,
  );
  assert.ok(open.calls.every(([operation]) => operation === "chmod"));
});

test(
  "real short daemon deadline aborts pending probe and releases its timer",
  { timeout: 2000 },
  async () => {
    const before = timeouts();
    let signal;
    const started = performance.now();
    await assert.rejects(
      within(25, "OWNED_DAEMON_TIMEOUT", (current) => {
        signal = current;
        return new Promise(() => {});
      }),
      { code: "OWNED_DAEMON_TIMEOUT" },
    );
    assert.ok(performance.now() - started < 1000);
    assert.equal(signal.aborted, true);
    await immediate();
    assert.equal(timeouts(), before);
  },
);

test("daemon success or failure clears the deadline timer", async () => {
  const before = timeouts();
  assert.equal(await within(1000, "OWNED_DAEMON_TIMEOUT", async () => "owned"), "owned");
  await assert.rejects(
    within(1000, "OWNED_DAEMON_TIMEOUT", async () => {
      throw Error("probe-failed");
    }),
    /probe-failed/,
  );
  await immediate();
  assert.equal(timeouts(), before);
});

test(
  "real short driver deadline resolves timeout and removes timer/listeners",
  { timeout: 2000 },
  async () => {
    const child = new EventEmitter();
    const before = timeouts();
    const started = performance.now();
    const watch = watchChildExit(child, 25);
    assert.deepEqual(await watch.promise, { timedOut: true });
    assert.ok(performance.now() - started < 1000);
    await immediate();
    assert.equal(timeouts(), before);
    assert.equal(child.listenerCount("exit") + child.listenerCount("error"), 0);
  },
);

test("driver exit/error and finally disposal all release the total timer", async () => {
  const before = timeouts();
  for (const event of ["exit", "error", "finally"]) {
    const child = new EventEmitter();
    const watch = watchChildExit(child, 180000);
    if (event === "finally") watch.dispose();
    else child.emit(event, event === "exit" ? 0 : Error("owned-spawn-failed"));
    const result = await watch.promise;
    assert.ok(
      event === "finally"
        ? result.cancelled
        : event === "exit"
          ? result.exit === 0
          : result.error instanceof Error,
    );
    watch.dispose();
    assert.equal(child.listenerCount("exit") + child.listenerCount("error"), 0);
  }
  await immediate();
  assert.equal(timeouts(), before);
});
