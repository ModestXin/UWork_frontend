import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer as createPortProbe } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createOwnedProcessTracker } from "./plugin-store-settings-navigation/ownedProcesses.mjs";

// Actual production Gateway panel and hook; finite public service delivery ports only.
const client = resolve(import.meta.dirname, "../../..");
assert.ok(process.argv[2], "Pass a new evidence directory");
const evidence = resolve(process.argv[2]);
const chromePath = process.env.UWORK_TEST_CHROME_PATH;
const browserHarnessPath = process.env.UWORK_TEST_BROWSER_HARNESS;
const bhPythonPath = process.env.UWORK_TEST_BH_PYTHON;
for (const [name, value] of Object.entries({
  UWORK_TEST_CHROME_PATH: chromePath,
  UWORK_TEST_BROWSER_HARNESS: browserHarnessPath,
  UWORK_TEST_BH_PYTHON: bhPythonPath,
})) {
  assert.ok(value && isAbsolute(value), `Set ${name} to an absolute owned test executable`);
  await access(value);
}
await mkdir(evidence, { mode: 0o700 });
const scratch = await mkdtemp("/tmp/uwork-gw-order-");
const daemonHome = join(scratch, "bh");
for (const name of ["home", "tmp", "config", "cache", "bh"])
  await mkdir(join(scratch, name), { mode: 0o700 });
const fixture = join(client, "packages/ui/test/gateway-view-delivery/main.tsx");
await writeFile(
  join(scratch, "index.html"),
  `<!doctype html><html><head><title>Owned Gateway view ordering probe</title><style>body{font:15px sans-serif;margin:16px}nav{display:flex;gap:8px;flex-wrap:wrap}button{padding:6px}output{display:block;max-height:80px;overflow:auto;font:12px monospace;margin:10px 0}section[data-testid=actual-panel]{border:1px solid #ccc;padding:16px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.space-y-6>div{margin-bottom:12px}</style></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
);
const probe = createPortProbe();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const fixturePort = probe.address().port;
await new Promise((done) => probe.close(done));
const server = await createServer({
  configFile: false,
  envFile: false,
  envDir: scratch,
  root: scratch,
  cacheDir: join(scratch, "vite-cache"),
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@", replacement: join(client, "packages/ui/src") },
      { find: /^@zcode\/shared$/, replacement: join(client, "packages/shared/src/index.ts") },
      { find: /^@zcode\/rpc$/, replacement: join(client, "packages/rpc/src/index.ts") },
      { find: "react-dom", replacement: join(client, "node_modules/react-dom") },
      { find: "react", replacement: join(client, "node_modules/react") },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: fixturePort,
    strictPort: true,
    fs: { allow: [client, evidence, scratch] },
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; object-src 'none'; frame-src 'none'",
    },
  },
  logLevel: "error",
});
const baseEnv = {
  PATH: dirname(process.execPath) + ":/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: join(scratch, "home"),
  USERPROFILE: join(scratch, "home"),
  TMPDIR: join(scratch, "tmp"),
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  LANG: "en_US.UTF-8",
};
const bhEnv = {
  ...baseEnv,
  BH_HOME: daemonHome,
  BH_RUNTIME_DIR: join(daemonHome, "runtime"),
  BH_TMP_DIR: join(daemonHome, "tmp"),
  BH_AGENT_WORKSPACE: join(daemonHome, "agent-workspace"),
  BH_CONFIG_DIR: daemonHome,
  BH_RECORD: "0",
  BH_DOMAIN_SKILLS: "0",
  BH_TELEMETRY: "0",
  BH_UPDATE_CHECK: "0",
  BU_NAME: "default",
};
const { owner, children, track, alive } = createOwnedProcessTracker(process.pid);
function lsof(args) {
  try {
    return execFileSync("/usr/sbin/lsof", ["-nP", ...args], { encoding: "utf8" });
  } catch (error) {
    if (error.status === 1 && !error.stdout) return "";
    throw error;
  }
}
let chrome,
  browser,
  cdpPort,
  origin,
  daemon,
  bhClean = false,
  driverDeadline;
const browserStderr = [];
let browserStderrBytes = 0;
const tracker = setInterval(track, 100);
try {
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const preflight = await fetch(origin);
  assert.equal(preflight.status, 200);
  await preflight.text();
  await writeFile(
    join(evidence, "local-http-preflight.json"),
    JSON.stringify({
      origin,
      status: preflight.status,
      rootEnvironmentFilesExcluded: true,
      externalRequest: false,
    }),
  );
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
      "--disable-breakpad",
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      "about:blank",
    ],
    { env: baseEnv, stdio: ["ignore", "ignore", "pipe"] },
  );
  chrome.stderr.on("data", (chunk) => {
    if (browserStderrBytes + chunk.length <= 65536) {
      browserStderr.push(chunk);
      browserStderrBytes += chunk.length;
    }
  });
  for (let n = 0; n < 200; n++) {
    try {
      cdpPort = Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
      );
      break;
    } catch {
      await delay(25);
    }
  }
  assert.ok(cdpPort, "Own Chrome CDP required");
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
        nativeBackendAndOldRootsTouched: false,
        rootEnvironmentFilesExcluded: true,
      },
      null,
      2,
    ),
  );
  const driver = await readFile(
    join(client, "packages/ui/test/gateway-view-delivery/driver.py"),
    "utf8",
  );
  browser = spawn(browserHarnessPath, [], {
    cwd: scratch,
    env: { ...bhEnv, BU_CDP_URL: `http://127.0.0.1:${cdpPort}`, BH_REQUIRE_EXISTING_DAEMON: "0" },
    stdio: ["pipe", "inherit", "inherit"],
  });
  const browserExit = new Promise((done) => {
    browser.once("error", (error) => done({ error }));
    browser.once("exit", (exit) => done({ exit }));
  });
  browser.stdin.end(
    `EVIDENCE=${JSON.stringify(evidence)}\nORIGIN=${JSON.stringify(origin)}\n` + driver,
  );
  for (let n = 0; n < 200 && !daemon; n++) {
    try {
      const runtime = bhEnv.BH_RUNTIME_DIR,
        files = (await readdir(runtime)).filter((name) => /^bu(?:-[\w-]+)?\.pid$/.test(name));
      assert.equal(files.length, 1);
      const pid = Number((await readFile(join(runtime, files[0]), "utf8")).trim());
      track();
      const row = children.get(pid);
      assert.ok(row && alive(row) && row.command.includes("python"));
      const sockets = lsof(["-a", "-p", String(pid), "-U", "-Fn"]);
      if (!sockets.includes(join(runtime, "bu.sock"))) {
        await delay(25);
        continue;
      }
      daemon = { ...row, pidFile: join(runtime, files[0]), sockets };
      children.set(pid, row);
      await writeFile(join(evidence, "daemon-owner.json"), JSON.stringify(daemon, null, 2));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ERR_ASSERTION") throw error;
      await delay(25);
    }
  }
  const result = await Promise.race([
    browserExit,
    new Promise((_, reject) => {
      driverDeadline = setTimeout(
        () => reject(new Error("Gateway browser regression exceeded 240 seconds")),
        240000,
      );
    }),
  ]);
  clearTimeout(driverDeadline);
  if (result.error) throw result.error;
  assert.ok(daemon, "Owned BH daemon ownership required");
  assert.equal(result.exit, 0, "Actual fixture driver must finish normally");
  const cases = JSON.parse(await readFile(join(evidence, "results.json"), "utf8"));
  assert.equal(cases.length, 10);
  await writeFile(
    join(evidence, "case-verdict.json"),
    JSON.stringify(
      {
        cases: cases.map((row) => ({
          case: row.case,
          classification: row.classification,
          checks: row.checks,
        })),
        driverErrors: cases.reduce((sum, row) => sum + row.driverErrors, 0),
        scope:
          "actual React production panel / finite valid RPC ordering only; no Native/HTTP identity claim",
      },
      null,
      2,
    ),
  );
  process.exitCode = cases.some((row) => row.driverErrors)
    ? 2
    : cases.some((row) => row.classification === "component-contract-RED")
      ? 1
      : 0;
} finally {
  clearTimeout(driverDeadline);
  clearInterval(tracker);
  track();
  if (browser?.exitCode === null && browser?.signalCode === null) browser.kill("SIGTERM");
  if (daemon && alive(daemon)) {
    const shutdown = spawn(
      bhPythonPath,
      [
        "-B",
        "-c",
        "from browser_harness.admin import restart_daemon; restart_daemon('default', require_clean=True)",
      ],
      { env: bhEnv, stdio: "ignore" },
    );
    bhClean = await new Promise((done) => {
      shutdown.once("error", () => done(false));
      shutdown.once("exit", (code) => done(code === 0));
    });
  }
  await server.close();
  if (chrome?.exitCode === null && chrome?.signalCode === null) chrome.kill("SIGTERM");
  await delay(250);
  track();
  for (const row of [...children.values()].reverse())
    if (alive(row)) {
      try {
        process.kill(row.pid, "SIGTERM");
      } catch {}
    }
  await delay(250);
  for (const row of [...children.values()].reverse())
    if (alive(row)) {
      try {
        process.kill(row.pid, "SIGKILL");
      } catch {}
    }
  await delay(100);
  const remaining = [...children.values()].filter(alive);
  const tcp = [origin && Number(new URL(origin).port), cdpPort]
    .filter(Boolean)
    .map((port) => ({ port, descriptors: lsof([`-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"]) }));
  const unix = daemon
    ? alive(daemon)
      ? lsof(["-a", "-p", String(daemon.pid), "-U", "-Fpcn"])
      : ""
    : "unverified";
  const allClosed =
    !!daemon && bhClean && remaining.length === 0 && tcp.every((row) => !row.descriptors) && !unix;
  await writeFile(join(evidence, "browser-stderr.log"), Buffer.concat(browserStderr));
  const fdScan = (() => {
    try {
      return execFileSync("/usr/sbin/lsof", ["-nP", "-Fpcfan", "+D", scratch], {
        encoding: "utf8",
      });
    } catch (error) {
      if (error.status === 1 && !error.stderr) return String(error.stdout || "");
      throw error;
    }
  })();
  const scratchWriters = fdScan.split("\n").filter((line) => line === "aw" || line === "au");
  assert.equal(scratchWriters.length, 0, "Only remove own scratch after writer check");
  if (allClosed) await rm(scratch, { force: true, recursive: true });
  await writeFile(
    join(evidence, "cleanup.json"),
    JSON.stringify(
      {
        processObservation:
          "pgrep -P only from exact runner/known child identities; exact ps -p metadata; PID 791 excluded",
        owner,
        bhCleanShutdownAcknowledged: bhClean,
        ownViteClosed: !server.httpServer.listening,
        knownProcesses: [...children.values()],
        remaining,
        tcp,
        unix,
        allClosed,
        ownScratchRemoved: allClosed,
        scratchScopedWriteFdCount: scratchWriters.length,
        scratchScopedFdOutput: fdScan,
        nativeOrRetainedRootsTouched: false,
      },
      null,
      2,
    ),
  );
  assert.ok(allClosed, "Unknown live resources: own scratch retained");
}
