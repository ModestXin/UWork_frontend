import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer as createPortProbe } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { extractNavigationCallbacks } from "./plugin-store-settings-navigation/actualCallbacks.mjs";
import { createOwnedProcessTracker } from "./plugin-store-settings-navigation/ownedProcesses.mjs";

// Standalone localhost React fixture. No Native/backend/DB or product output.
const client = resolve(import.meta.dirname, "../../..");
assert.ok(process.argv[2], "Pass a new evidence directory");
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { mode: 0o700 });
// macOS AF_UNIX has a short path limit; never place BH under long $TMPDIR.
const scratch = await mkdtemp("/tmp/uwork-pnav-");
const daemonHome = join(scratch, "bh");
for (const name of ["home", "tmp", "config", "cache", "bh"])
  await mkdir(join(scratch, name), { mode: 0o700 });
const chromePath =
  "/Users/ljp/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";
await access(chromePath);
const fixture = join(client, "packages/ui/test/plugin-store-settings-navigation/main.tsx");
const source = await extractNavigationCallbacks(client);
await writeFile(join(evidence, "actual-callback-sources.json"), JSON.stringify(source, null, 2), {
  flag: "wx",
  mode: 0o600,
});
await writeFile(
  join(scratch, "index.html"),
  `<!doctype html><html><head><title>Owned plugin navigation regression</title></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
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
  plugins: [
    {
      name: "actual-plugin-navigation-callbacks",
      resolveId(id) {
        if (id === "virtual:actual-plugin-navigation") return "\0actual-plugin-navigation.js";
      },
      load(id) {
        if (id === "\0actual-plugin-navigation.js") return source.code;
      },
    },
    react(),
  ],
  resolve: { alias: { "@": join(client, "packages/ui/src") } },
  server: {
    host: "127.0.0.1",
    port: fixturePort,
    strictPort: true,
    fs: { allow: [client, scratch] },
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
  bhClean = false;
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
    join(client, "packages/ui/test/plugin-store-settings-navigation/driver.py"),
    "utf8",
  );
  browser = spawn("/Users/ljp/.local/bin/browser-harness", [], {
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
  const result = await browserExit;
  if (result.error) throw result.error;
  assert.ok(daemon, "Owned BH daemon ownership required");
  process.exitCode = result.exit === 0 ? 0 : 1;
} finally {
  clearInterval(tracker);
  track();
  if (browser?.exitCode === null && browser?.signalCode === null) browser.kill("SIGTERM");
  if (daemon && alive(daemon)) {
    const shutdown = spawn(
      "/Users/ljp/.local/share/uv/tools/browser-harness/bin/python",
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
        nativeOrRetainedRootsTouched: false,
      },
      null,
      2,
    ),
  );
  assert.ok(allClosed, "Unknown live resources: own scratch retained");
}
