// Test-only process observer: never enumerate the system process table.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const allowed = (pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== 791;
export const sameIdentity = (a, b) =>
  !!a && !!b && a.pid === b.pid && a.birth === b.birth && a.command === b.command;

export function readProcess(pid) {
  assert.ok(allowed(pid), "Only exact allowed process IDs may be observed");
  let output;
  try {
    output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,lstart=,comm="], {
      encoding: "utf8",
    });
  } catch (error) {
    if (error.status === 1 && !error.stdout) return null;
    throw error;
  }
  const match = output.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
  if (!match) return null;
  const row = { pid: Number(match[1]), ppid: Number(match[2]), birth: match[3], command: match[4] };
  assert.equal(row.pid, pid);
  return row;
}

function directChildren(pid) {
  assert.ok(allowed(pid));
  try {
    return execFileSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(allowed);
  } catch (error) {
    if (error.status === 1 && !error.stdout) return [];
    throw error;
  }
}

export function createOwnedProcessTracker(
  ownerPid,
  read = readProcess,
  childrenOf = directChildren,
) {
  assert.ok(allowed(ownerPid));
  const owner = read(ownerPid);
  assert.ok(owner, "Current runner identity required");
  const children = new Map();
  const alive = (row) => allowed(row.pid) && sameIdentity(row, read(row.pid));
  function track() {
    assert.ok(alive(owner), "Runner identity changed; stop process discovery");
    const queue = [owner, ...children.values()];
    const visited = new Set();
    for (const parent of queue) {
      if (visited.has(parent.pid) || !alive(parent)) continue;
      visited.add(parent.pid);
      for (const pid of childrenOf(parent.pid)) {
        if (!allowed(pid) || pid === owner.pid) continue;
        const row = read(pid);
        // Recheck parent after discovery and retain original PID/birth evidence.
        if (!row || row.ppid !== parent.pid || !alive(parent)) continue;
        const previous = children.get(pid);
        if (previous && !sameIdentity(previous, row)) continue;
        if (!previous) children.set(pid, row);
        queue.push(previous ?? row);
      }
    }
  }
  return { owner, children, track, alive };
}
