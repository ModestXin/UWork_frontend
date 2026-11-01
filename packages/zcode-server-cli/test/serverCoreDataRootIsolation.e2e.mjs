import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connectViaWebSocket } from "../../client/src/websocket.ts";
import { resolveServerLayout } from "../src/runtime/paths.ts";
import { ReleaseManager } from "../src/runtime/releaseManager.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const target = `${process.platform}-${process.arch}`;
const runtime = join(packageRoot, "dist-release", `zcode-server-${target}`, "runtime");
const runtimeNode = join(runtime, process.platform === "win32" ? "node.exe" : "node");

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned test timeout: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "original staged Core fences conflicting inherited profiles before service imports, including legacy Supervisor launch",
  { timeout: 30000 },
  async () => {
    await access(runtimeNode);
    await access(join(runtime, "server-core.js"));
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "uwork-server-profile-")));
    const roots = Object.fromEntries(
      ["server", "home", "uwork", "desktop", "storage"].map((name) => [
        name,
        join(temporary, name),
      ]),
    );
    await Promise.all(Object.values(roots).map((path) => mkdir(path, { mode: 0o700 })));
    await new ReleaseManager(resolveServerLayout(roots.server)).ensure();
    const parentBefore = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      UWORK_DATA_BASE_DIR: process.env.UWORK_DATA_BASE_DIR,
    };
    const environment = {
      PATH:
        dirname(runtimeNode) +
        (process.platform === "win32" ? ";" : ":") +
        (process.platform === "win32" ? process.env.SystemRoot + "\\System32" : "/usr/bin:/bin"),
      HOME: roots.home,
      USERPROFILE: roots.home,
      UWORK_DATA_BASE_DIR: roots.uwork,
      ZCODE_DATA_BASE_DIR: roots.server,
      ZCODE_DESKTOP_HOME_DIR: roots.desktop,
      ZCODE_STORAGE_DIR: roots.storage,
      ZCODE_SERVER_ROOT: roots.server,
      ZCODE_SERVER_RUNTIME_ROOT: runtime,
      ZCODE_AGENT_SERVER_COMMAND: runtimeNode,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
        join(runtime, "zcode.cjs"),
        "app-server",
        "--stdio",
      ]),
      NODE_ENV: "production",
    };
    const child = fork(join(runtime, "server-core.js"), ["1"], {
      execPath: runtimeNode,
      execArgv: [],
      cwd: roots.server,
      env: environment,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "",
      socket,
      primaryFailure;
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString().slice(0, 4000 - stderr.length);
    });
    const exited = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      const ready = await bounded(
        new Promise((resolve, reject) => {
          child.on("message", (message) => {
            if (message.type === "ready") resolve(message);
            if (message.type === "fatal") reject(new Error(message.message));
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(new Error(`Original Core exited before ready: ${code}; ${stderr}`)),
          );
        }),
        15000,
        "original Core ready",
      );
      const services = await connectViaWebSocket(`ws://127.0.0.1:${ready.port}/ws`, {
        onOpenSocket(value) {
          socket = value;
        },
      });
      const info = await bounded(services.systemService.info(), 5000, "system profile");
      const workspace = await bounded(
        services.fileService.ensureConversationWorkspace(),
        5000,
        "owned temporary default workspace",
      );
      await bounded(
        services.settingService.update({ locale: "en-US", terminalInheritSystemProfile: false }),
        5000,
        "owned temporary setting write",
      );
      const files = [];
      for (const [key, value] of Object.entries(roots)) {
        const path = join(value, ".uwork/v2/setting.json");
        if (
          await access(path).then(
            () => true,
            () => false,
          )
        ) {
          const settings = JSON.parse(await readFile(path, "utf8"));
          files.push({ root: key, locale: settings.locale });
        }
      }
      assert.deepEqual(
        { home: info.homedir, workspace: workspace.path, settings: files },
        {
          home: roots.server,
          workspace: join(roots.server, ".uwork/workspace/default"),
          settings: [{ root: "server", locale: "en-US" }],
        },
        "Core must consume the authoritative server data-root, not ambient HOME/UWORK/DESKTOP profile paths",
      );
      assert.deepEqual(
        {
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          UWORK_DATA_BASE_DIR: process.env.UWORK_DATA_BASE_DIR,
        },
        parentBefore,
      );
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      socket?.close();
      if (child.connected) child.send({ command: "shutdown" });
      try {
        const result = await bounded(exited, 5000, "original Core shutdown");
        if (!primaryFailure) assert.deepEqual(result, { code: 0, signal: null });
      } catch (error) {
        child.kill("SIGKILL");
        await exited;
        throw error;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  },
);
