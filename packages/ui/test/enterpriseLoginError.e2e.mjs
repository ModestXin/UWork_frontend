import assert from "node:assert/strict";
import { spawn, execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as createPortProbe } from "node:net";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  browserEnvironment,
  inspectRootFds,
  retireRoots,
  watchChildExit,
  within,
} from "./enterprise-login-error/runnerSafety.mjs";

const exec = promisify(execFile);

// Shared React UI only. A new localhost server, Chrome profile, CDP and BH per run.
const client = resolve(import.meta.dirname, "../../..");
assert.ok(process.argv[2], "Pass a new evidence directory; existing evidence is never reused");
const evidence = resolve(process.argv[2]);
const cases = process.argv[3] ?? "reopen";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await access(chromePath);
await mkdir(dirname(evidence), { recursive: true });
await mkdir(evidence, { mode: 0o700 });
const scratch = await mkdtemp(join(tmpdir(), "uwork-login-error-"));
const daemonHome = await mkdtemp(join(tmpdir(), "bh-login-"));
await chmod(scratch, 0o700);
await chmod(daemonHome, 0o700);
const fixture = join(client, "packages/ui/test/enterprise-login-error/main.tsx");
await writeFile(
  join(scratch, "index.html"),
  `<!doctype html><html><head><title>Owned login error fixture</title></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
);
const portProbe = createPortProbe();
await new Promise((done) => portProbe.listen(0, "127.0.0.1", done));
const fixturePort = portProbe.address().port;
await new Promise((done) => portProbe.close(done));
const server = await createServer({
  configFile: false,
  envFile: false,
  envDir: scratch,
  root: scratch,
  cacheDir: join(scratch, "vite-cache"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": join(client, "packages/ui/src") } },
  server: {
    host: "127.0.0.1",
    port: fixturePort,
    strictPort: true,
    fs: { allow: [client, scratch] },
  },
  logLevel: "error",
});
const children = new Map();
const maxOwnedProcesses = 256;
async function processRows(pids) {
  assert.ok(pids.length > 0 && pids.length <= maxOwnedProcesses, "Bounded owned PID query");
  let output;
  try {
    ({ stdout: output } = await exec(
      "ps",
      ["-p", pids.join(","), "-o", "pid=,ppid=,lstart=,command="],
      {
        encoding: "utf8",
        maxBuffer: 512 * 1024,
        timeout: 1000,
      },
    ));
  } catch (error) {
    if (error.code === 1 && !error.stdout && !error.stderr) return [];
    throw error;
  }
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
      return match
        ? { pid: Number(match[1]), ppid: Number(match[2]), birth: match[3], command: match[4] }
        : null;
    })
    .filter(Boolean);
}
const owner = (await processRows([process.pid])).find((row) => row.pid === process.pid);
assert.ok(owner, "This runner must have its own PID/birth identity");
async function alive(row) {
  return (await processRows([row.pid])).some(
    (current) => current.pid === row.pid && current.birth === row.birth,
  );
}
async function rememberSpawn(child) {
  if (!child.pid) return;
  const row = (await processRows([child.pid])).find((current) => current.ppid === owner.pid);
  if (row) children.set(row.pid, row);
}
async function childPids(pid) {
  try {
    const { stdout: output } = await exec("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 1000,
    });
    const pids = output.trim().split(/\s+/).filter(Boolean).map(Number);
    assert.ok(
      pids.length <= maxOwnedProcesses && pids.every((id) => Number.isInteger(id) && id > 0),
    );
    return pids;
  } catch (error) {
    if (error.code === 1 && !error.stdout && !error.stderr) return [];
    throw error;
  }
}
async function track() {
  const queue = [owner, ...children.values()];
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    if (stopTracking) return;
    if (!(await alive(parent))) continue;
    if (stopTracking) return;
    const pids = await childPids(parent.pid);
    // 停止或 parent 被复用时不再扩树；每个异步查询均有 1 秒上限。
    if (stopTracking) return;
    if (!pids.length || !(await alive(parent))) continue;
    if (stopTracking) return;
    for (const row of await processRows(pids)) {
      if (stopTracking) return;
      if (row.ppid !== parent.pid) continue;
      const previous = children.get(row.pid);
      assert.ok(!previous || previous.birth === row.birth, "Owned descendant PID was reused");
      if (previous) continue;
      assert.ok(children.size + 1 < maxOwnedProcesses, "Owned process tree exceeded its bound");
      children.set(row.pid, row);
      queue.push(row);
    }
  }
}
let trackingError, trackingTask;
let stopTracking = false;
function trackSafely() {
  if (stopTracking || trackingError) return Promise.resolve();
  trackingTask ??= track()
    .catch((error) => {
      trackingError = error;
    })
    .finally(() => {
      trackingTask = null;
    });
  return trackingTask;
}
let chrome, browser, cdpPort, origin, browserWatch;
let daemon;
let driverSucceeded = false;
async function lsof(args) {
  try {
    return (
      await exec("lsof", ["-nP", ...args], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 256 * 1024,
      })
    ).stdout;
  } catch (error) {
    if (error.code === 1 && !error.stdout && !error.stderr) return "";
    throw error;
  }
}
const tracker = setInterval(() => {
  void trackSafely();
}, 100);
try {
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const profile = join(scratch, "chrome");
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await rememberSpawn(chrome);
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      cdpPort = Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
      );
      break;
    } catch {
      await delay(25);
    }
  }
  assert.ok(cdpPort, "Own Chrome must have its own CDP endpoint");
  await writeFile(
    join(evidence, "runtime.json"),
    JSON.stringify(
      {
        pid: process.pid,
        origin,
        chromePid: chrome.pid,
        cdpPort,
        profile,
        scratch,
        daemonHome,
        rootEnvFilesExcluded: true,
        nativeTouched: false,
        actualWecomAndModels: 0,
      },
      null,
      2,
    ),
  );
  const driver = await readFile(
    join(client, "packages/ui/test/enterprise-login-error/driver.py"),
    "utf8",
  );
  browser = spawn("browser-harness", [], {
    cwd: scratch,
    env: browserEnvironment(process.env, { scratch, daemonHome }, cdpPort),
    stdio: ["pipe", "inherit", "inherit"],
  });
  browserWatch = watchChildExit(browser, 180000);
  await rememberSpawn(browser);
  browser.stdin.end(
    `EVIDENCE=${JSON.stringify(evidence)}\nORIGIN=${JSON.stringify(origin)}\nCASES=${JSON.stringify(cases)}\n` +
      driver,
  );
  // BH daemon may reparent before the driver exits. Its owned PID file and socket,
  // not a generic command name or ancestry alone, establish cleanup ownership.
  await within(5000, "OWNED_DAEMON_TIMEOUT", async (signal) => {
    while (!daemon) {
      signal.throwIfAborted();
      try {
        const runtime = join(daemonHome, "runtime");
        const files = (await readdir(runtime)).filter((name) => /^bu(?:-[\w-]+)?\.pid$/.test(name));
        assert.equal(files.length, 1, "Exactly one daemon PID file in this run's owned runtime");
        const pid = Number((await readFile(join(runtime, files[0]), "utf8")).trim());
        assert.ok(Number.isInteger(pid) && pid > 0, "Owned daemon PID file must hold one PID");
        signal.throwIfAborted();
        const row = (await processRows([pid])).find((current) => current.pid === pid);
        signal.throwIfAborted();
        assert.ok(
          row && /(?:^|\s)-m browser_harness\.daemon(?:\s|$)/.test(row.command),
          "Owned daemon PID must still name BH daemon",
        );
        const sockets = await lsof(["-a", "-p", String(pid), "-U", "-Fn"]);
        signal.throwIfAborted();
        if (!sockets.includes(join(runtime, "bu.sock"))) {
          await delay(25, undefined, { signal });
          continue;
        }
        daemon = { ...row, pidFile: join(runtime, files[0]), sockets };
        assert.ok(children.size + 1 < maxOwnedProcesses, "Owned process tree exceeded its bound");
        children.set(pid, row);
        await writeFile(join(evidence, "daemon-owner.json"), JSON.stringify(daemon, null, 2));
      } catch (error) {
        if (error.code !== "ENOENT" && !(error.code === "ERR_ASSERTION" && !daemon)) throw error;
        await delay(25, undefined, { signal });
      }
    }
  });
  assert.ok(daemon, "Unverified BH daemon; preserve owned roots on cleanup");
  const result = await browserWatch.promise;
  if (result.error) throw result.error;
  if (result.timedOut) throw new Error("OWNED_DRIVER_TIMEOUT");
  driverSucceeded = result.exit === 0;
  if (!driverSucceeded) process.exitCode = Number(result.exit ?? 1);
} finally {
  browserWatch?.dispose();
  clearInterval(tracker);
  stopTracking = true;
  await trackingTask;
  let serverCloseCompleted = false;
  try {
    await within(3000, "OWNED_VITE_CLOSE_TIMEOUT", () => server.close());
    serverCloseCompleted = true;
  } catch {
    // Vite 仍可能等待 transform；关闭不确定也继续清理已知进程，并保留两新根。
  }
  if (browser?.exitCode === null && browser?.signalCode === null) browser.kill("SIGTERM");
  if (chrome?.exitCode === null && chrome?.signalCode === null) chrome.kill("SIGTERM");
  for (const row of [...children.values()].reverse())
    if (await alive(row)) {
      try {
        process.kill(row.pid, "SIGTERM");
      } catch {}
    }
  await delay(300);
  for (const row of [...children.values()].reverse())
    if (await alive(row)) {
      try {
        process.kill(row.pid, "SIGKILL");
      } catch {}
    }
  await delay(100);
  const remaining = [];
  for (const row of children.values()) if (await alive(row)) remaining.push(row);
  const ports = [origin && Number(new URL(origin).port), cdpPort].filter(Boolean);
  const liveOwnedPids = [process.pid, ...remaining.map((row) => row.pid)].join(",");
  const tcp = await Promise.all(
    ports.map(async (port) => ({
      port,
      descriptors: await lsof(["-a", "-p", liveOwnedPids, `-iTCP:${port}`, "-Fpcn"]),
    })),
  );
  const unixSockets = (await lsof(["-a", "-p", liveOwnedPids, "-U", "-Fpcn"]))
    .split("\n")
    .filter((line) => line.includes(daemonHome));
  const allClosed =
    serverCloseCompleted &&
    !trackingError &&
    !!daemon &&
    remaining.length === 0 &&
    tcp.every((item) => !item.descriptors) &&
    unixSockets.length === 0;
  const rootFds = inspectRootFds(
    { scratch, daemonHome },
    new Set([process.pid, ...remaining.map((row) => row.pid)]),
    spawnSync,
  );
  const rootsRetired = await retireRoots(
    { scratch, daemonHome },
    { driverSucceeded, resourcesClosed: allClosed, rootFds },
    { rm, chmod },
  );
  await writeFile(
    join(evidence, "cleanup.json"),
    JSON.stringify(
      {
        ownViteClosed: serverCloseCompleted,
        knownProcesses: [...children.values()],
        remaining,
        trackingFailed: !!trackingError,
        processQueryScope: "owned-pid-ppid-birth-tree",
        ports,
        daemon,
        tcp,
        unixSockets,
        allClosed,
        driverSucceeded,
        rootFds,
        rootsRetired,
        ownScratchRemoved: rootsRetired.removed,
        nativeTouched: false,
      },
      null,
      2,
    ),
  );
  assert.ok(
    driverSucceeded && allClosed && rootsRetired.removed,
    "Driver failed or cleanup unverified; owned roots preserved",
  );
}
