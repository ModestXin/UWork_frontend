import { join } from "node:path";

const rootEntries = (roots) => {
  const entries = ["scratch", "daemonHome"].map((label) => [label, roots[label]]);
  if (
    entries.some(([, path]) => typeof path !== "string" || !path || path === "/") ||
    roots.scratch === roots.daemonHome
  )
    throw new Error("OWNED_ROOT_SCOPE_INVALID");
  return entries;
};

export function browserEnvironment(inherited, roots, cdpPort) {
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535)
    throw new Error("OWNED_CDP_INVALID");
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) => !/^(BU_|BH_|BROWSER_USE_|BROWSER_HARNESS_)/.test(key) && key !== "DEBUG",
    ),
  );
  return {
    ...env,
    BH_HOME: roots.daemonHome,
    BH_RUNTIME_DIR: join(roots.daemonHome, "runtime"),
    BH_TMP_DIR: join(roots.daemonHome, "tmp"),
    BH_AGENT_WORKSPACE: join(roots.daemonHome, "agent-workspace"),
    BH_CONFIG_DIR: roots.daemonHome,
    BU_NAME: "default",
    BU_CDP_URL: `http://127.0.0.1:${cdpPort}`,
    BH_RECORD: "0",
    BH_TELEMETRY: "0",
    BH_DEBUG_CLICKS: "",
    DEBUG: "",
  };
}

export async function within(milliseconds, code, operation) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Object.assign(new Error(code), { code });
          reject(error);
          controller.abort(error);
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function watchChildExit(child, milliseconds) {
  let timer, finish;
  const promise = new Promise((resolve) => {
    let settled = false;
    const onError = (error) => finish({ error });
    const onExit = (exit) => finish({ exit });
    finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(result);
    };
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => finish({ timedOut: true }), milliseconds);
  });
  return { promise, dispose: () => finish({ cancelled: true }) };
}

// 仅两个新根的 PID/FD 字段进入 RAM；未知持有者只聚合计数，绝不查询身份或 signal。
export function inspectRootFds(roots, ownedPids, query) {
  const unknown = new Set();
  const summaries = rootEntries(roots).map(([label, path]) => {
    const summary = { label, complete: false, openFds: 0 };
    try {
      const result = query("lsof", ["-nP", "+D", path, "-Fpf"], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 128 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = String(result.stdout ?? "").trim();
      if (result.error || result.signal || String(result.stderr ?? "").trim()) return summary;
      if (result.status === 1 && !output) return { ...summary, complete: true };
      if (result.status !== 0 || !output) return summary;
      let pid = null,
        hasFd = false;
      for (const line of output.split("\n")) {
        if (/^p[1-9]\d*$/.test(line)) {
          if (pid !== null && !hasFd) return summary;
          pid = Number(line.slice(1));
          hasFd = false;
        } else if (/^f(?:\d+|cwd|rtd|txt|mem|del)$/i.test(line) && pid !== null) {
          summary.openFds++;
          hasFd = true;
          if (!ownedPids.has(pid)) unknown.add(pid);
        } else return summary;
      }
      summary.complete = hasFd;
    } catch {
      // 包括查询超时、截断和权限不确定；只保根，不记录原始错误或查询输出。
    }
    return summary;
  });
  return {
    complete: summaries.every((summary) => summary.complete),
    openFds: summaries.reduce((count, summary) => count + summary.openFds, 0),
    unknownHolders: unknown.size,
    roots: summaries,
  };
}

export async function retireRoots(roots, state, io) {
  const remove =
    state.driverSucceeded === true &&
    state.resourcesClosed === true &&
    state.rootFds.complete === true &&
    state.rootFds.openFds === 0 &&
    state.rootFds.unknownHolders === 0;
  const entries = rootEntries(roots);
  if (remove) {
    for (const [, path] of entries) await io.rm(path, { recursive: true, force: true });
    return { removed: true, preserved: false, privateModesApplied: false };
  }
  const modes = await Promise.allSettled(entries.map(([, path]) => io.chmod(path, 0o700)));
  return {
    removed: false,
    preserved: true,
    privateModesApplied: modes.every((mode) => mode.status === "fulfilled"),
  };
}
