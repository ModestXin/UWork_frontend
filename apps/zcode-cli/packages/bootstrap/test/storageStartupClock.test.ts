import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import test from "node:test";
import { zcodeStorageStartupStateSchema } from "@zcode/shared";
import { openProtocolStartupStorage } from "../src/zcode-protocol/storage-startup.js";

test("real startup schema and SQL commit survive a backwards wall clock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uwork-startup-clock-"));
  const dbPath = join(directory, "session.sqlite");
  const frames: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(String(chunk));
      callback();
    },
  });
  const originalNow = Date.now;
  let rollback = 0;
  t.mock.method(Date, "now", () => originalNow() - (rollback += 100));
  try {
    const store = await openProtocolStartupStorage({ dbPath, output });
    store.close();
    const states = frames
      .join("")
      .trim()
      .split("\n")
      .map((line) => zcodeStorageStartupStateSchema.parse(JSON.parse(line).params));
    assert.equal(states.at(-1)?.phase, "ready");
    assert.ok(states.every((state) => state.elapsedMs >= 0));
    assert.equal(
      states.some((state) => state.phase === "failed"),
      false,
    );
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("select count(*) count, min(time_applied) earliest from schema_migration")
        .get() as { count: number; earliest: number };
      assert.ok(row.count > 0);
      assert.equal(row.count, states.at(-1)?.migration?.committedCount);
      assert.ok(
        row.earliest > 1_000_000_000_000,
        "Persisted journal timestamps must remain epoch wall time",
      );
    } finally {
      db.close();
    }
  } finally {
    output.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
