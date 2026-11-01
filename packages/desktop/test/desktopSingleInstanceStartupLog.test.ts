import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  elapsedSingleInstanceStartupMs,
  readSingleInstanceStartupTime,
  recordSingleInstanceStartupPhase,
} from "../src/main/desktopSingleInstanceStartupLog.js";

test("four fixed phases emit only allowed scalar fields, never original payload", () => {
  const rows: unknown[][] = [];
  const logger = { info: (...args: unknown[]) => rows.push(args) };
  const privateFields = { argv: ["PRIVATE_ARGV"], uri: "PRIVATE_URI", env: "PRIVATE_ENV" };
  recordSingleInstanceStartupPhase(logger, { phase: "lock-request-start", ...privateFields });
  recordSingleInstanceStartupPhase(logger, {
    phase: "lock-request-return",
    acquired: false,
    elapsedMs: 5.25,
    ...privateFields,
  });
  recordSingleInstanceStartupPhase(logger, { phase: "secondary-quit-start", ...privateFields });
  recordSingleInstanceStartupPhase(logger, {
    phase: "secondary-quit-return",
    elapsedMs: 1,
    ...privateFields,
  });
  assert.deepEqual(rows, [
    [
      "[single-instance-startup]",
      { event: "desktop_single_instance_startup", phase: "lock-request-start" },
    ],
    [
      "[single-instance-startup]",
      {
        event: "desktop_single_instance_startup",
        phase: "lock-request-return",
        acquired: false,
        elapsedMs: 5.25,
      },
    ],
    [
      "[single-instance-startup]",
      { event: "desktop_single_instance_startup", phase: "secondary-quit-start" },
    ],
    [
      "[single-instance-startup]",
      { event: "desktop_single_instance_startup", phase: "secondary-quit-return", elapsedMs: 1 },
    ],
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
});

test("logger failure is isolated without a second sink or exception replacement", () => {
  let calls = 0;
  const logger = {
    info: () => {
      calls++;
      throw new Error("PRIVATE_LOG_FAILURE");
    },
  };
  assert.doesNotThrow(() =>
    recordSingleInstanceStartupPhase(logger, { phase: "lock-request-start" }),
  );
  assert.equal(calls, 1);
});

test("monotonic clock failures and invalid samples are unavailable, never fabricated elapsed", (t) => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    t.mock.method(performance, "now", () => value);
    assert.equal(readSingleInstanceStartupTime(), undefined);
    assert.equal(elapsedSingleInstanceStartupMs(1), undefined);
    t.mock.restoreAll();
  }
  t.mock.method(performance, "now", () => {
    throw new Error("clock unavailable");
  });
  assert.equal(readSingleInstanceStartupTime(), undefined);
  assert.equal(elapsedSingleInstanceStartupMs(1), undefined);
});

test("elapsed uses monotonic differences and rejects missing or backwards readings", (t) => {
  t.mock.method(performance, "now", () => 15.5);
  assert.equal(elapsedSingleInstanceStartupMs(10), 5.5);
  assert.equal(elapsedSingleInstanceStartupMs(undefined), undefined);
  assert.equal(elapsedSingleInstanceStartupMs(16), undefined);
  assert.equal(elapsedSingleInstanceStartupMs(Number.NaN), undefined);
});

test("unavailable elapsed is omitted rather than emitted as zero or null", () => {
  const rows: unknown[][] = [];
  for (const elapsedMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    recordSingleInstanceStartupPhase(
      { info: (...args: unknown[]) => rows.push(args) },
      {
        phase: "lock-request-return",
        acquired: true,
        elapsedMs,
      },
    );
  }
  for (const [, row] of rows) {
    assert.deepEqual(row, {
      event: "desktop_single_instance_startup",
      phase: "lock-request-return",
      acquired: true,
    });
  }
});
