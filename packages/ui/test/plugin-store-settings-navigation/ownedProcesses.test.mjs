import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createOwnedProcessTracker, readProcess } from "./ownedProcesses.mjs";

test("discovery only follows original owned identities; rejects 791, foreign parents and reused PIDs", () => {
  const row = (pid, ppid, birth = "original") => ({ pid, ppid, birth, command: "owned" });
  const rows = new Map([
    [100, row(100, 1)],
    [101, row(101, 100)],
    [102, row(102, 101)],
    [103, row(103, 900)],
  ]);
  const reads = [],
    traversals = [];
  const tracker = createOwnedProcessTracker(
    100,
    (pid) => {
      reads.push(pid);
      return rows.get(pid);
    },
    (pid) => {
      traversals.push(pid);
      return pid === 100 ? [101, 103, 791] : pid === 101 ? [102] : [];
    },
  );
  tracker.track();
  assert.deepEqual([...tracker.children.keys()], [101, 102]);
  assert.ok(!reads.includes(791) && !reads.includes(900));
  assert.ok(!traversals.includes(791) && !traversals.includes(103));
  const originalChild = tracker.children.get(101);
  rows.set(101, row(101, 100, "reused"));
  rows.set(102, row(102, 1));
  reads.length = traversals.length = 0;
  tracker.track();
  assert.equal(tracker.alive(originalChild), false);
  assert.ok(!traversals.includes(101), "Never recurse into a reused PID");
  assert.equal(
    tracker.alive(tracker.children.get(102)),
    true,
    "Known descendant may survive reparenting",
  );
  rows.set(100, row(100, 1, "reused"));
  assert.throws(() => tracker.track(), /Runner identity changed/);
  assert.throws(() => readProcess(791), /exact allowed/);
});

test("real own child is captured by pgrep parent traversal and cleanup verifies exact birth", async () => {
  const tracker = createOwnedProcessTracker(process.pid);
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", "setInterval(() => {}, 1000)"],
    {
      env: { PATH: "/usr/bin:/bin" },
      stdio: "ignore",
    },
  );
  const exited = once(child, "exit");
  let identity;
  try {
    for (let attempt = 0; attempt < 40 && !identity; attempt++) {
      tracker.track();
      identity = tracker.children.get(child.pid);
      if (!identity) await delay(25);
    }
    assert.ok(identity && tracker.alive(identity));
    assert.equal(identity.ppid, process.pid);
  } finally {
    if (identity ? tracker.alive(identity) : child.exitCode === null) child.kill("SIGTERM");
    await exited;
  }
  assert.equal(tracker.alive(identity), false);
});
