import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  runSqliteSessionMigrations,
  runSqliteSessionMigrationsAsync,
  type SqliteMigrationProgress,
} from "../src/storage/session-store/migration-runner.js";
import { SqliteSessionMigrationError } from "../src/storage/session-store/errors.js";

test("a finite wall rollback cannot extend the real SQLite busy deadline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uwork-clock-busy-back-"));
  const path = join(directory, "session.sqlite");
  const owner = new DatabaseSync(path);
  let waiter: DatabaseSync | undefined;
  try {
    runSqliteSessionMigrations(owner, path);
    owner.exec("begin immediate");
    waiter = new DatabaseSync(path);
    const originalNow = Date.now;
    let reads = 0;
    t.mock.method(Date, "now", () => originalNow() - (reads++ === 0 ? 0 : 500));
    const started = performance.now();
    await assert.rejects(
      runSqliteSessionMigrationsAsync(waiter, path, { lockWaitTimeoutMs: 80 }),
      (error: unknown) =>
        error instanceof SqliteSessionMigrationError && error.kind === "lock_timeout",
    );
    assert.ok(
      performance.now() - started < 350,
      "An 80 ms local lock budget must not gain the 500 ms wall rollback",
    );
    assert.equal(waiter.isTransaction, false);
    assert.equal(
      (waiter.prepare("pragma busy_timeout").get() as { timeout: number }).timeout,
      5000,
    );
  } finally {
    waiter?.close();
    if (owner.isTransaction) owner.exec("rollback");
    owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a wall forward jump cannot expire a valid lock wait before the real writer releases", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uwork-clock-busy-forward-"));
  const path = join(directory, "session.sqlite");
  const owner = new DatabaseSync(path);
  let waiter: DatabaseSync | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    runSqliteSessionMigrations(owner, path);
    owner.exec("begin immediate");
    waiter = new DatabaseSync(path);
    const originalNow = Date.now;
    let reads = 0;
    t.mock.method(Date, "now", () => originalNow() + (reads++ === 0 ? 0 : 60_000));
    release = setTimeout(() => owner.exec("rollback"), 120);
    const phases: SqliteMigrationProgress[] = [];
    await runSqliteSessionMigrationsAsync(waiter, path, {
      lockWaitTimeoutMs: 800,
      onProgress: async (progress) => {
        phases.push(progress);
      },
    });
    assert.ok(phases.some((progress) => progress.phase === "waiting_for_lock"));
    assert.equal(phases.at(-1)?.phase, "ready");
    assert.equal(owner.isTransaction, false);
  } finally {
    clearTimeout(release);
    waiter?.close();
    if (owner.isTransaction) owner.exec("rollback");
    owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real migration SQL failure keeps its cause, rolls back and restores native busy timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uwork-clock-sql-error-"));
  const path = join(directory, "session.sqlite");
  const db = new DatabaseSync(path);
  const phases: SqliteMigrationProgress[] = [];
  try {
    db.exec("create table session (id text primary key)");
    await assert.rejects(
      runSqliteSessionMigrationsAsync(db, path, {
        onProgress: async (progress) => {
          phases.push(progress);
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SqliteSessionMigrationError);
        assert.equal(error.kind, "sql_failed");
        assert.equal(error.migrationId, "0001_base_session_store");
        assert.equal((error.cause as { errcode: number }).errcode & 0xff, 1);
        return true;
      },
    );
    assert.equal(db.isTransaction, false);
    assert.equal(
      db.prepare("select name from sqlite_master where name='schema_migration'").get(),
      undefined,
    );
    assert.equal((db.prepare("pragma busy_timeout").get() as { timeout: number }).timeout, 5000);
    assert.equal(phases.at(-1)?.phase, "failed");
    assert.equal(phases.at(-1)?.errorCode, "sql_failed");
    assert.equal(phases.at(-1)?.sqliteCode, 1);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
