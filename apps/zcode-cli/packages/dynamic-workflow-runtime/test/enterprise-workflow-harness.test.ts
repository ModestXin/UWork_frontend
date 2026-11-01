import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  InMemoryJournalStore,
  validate as validateSchema,
  type JsonSchema,
  type WorkflowDriver,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/harness.js";

const validate = (schema: unknown, value: unknown) => validateSchema(schema as JsonSchema, value);

function driver(journal: InMemoryJournalStore): WorkflowDriver {
  const unexpected = () => {
    throw new Error("no actor or world IO is expected");
  };
  return {
    journal,
    emit: () => {},
    createActorSession: async () => unexpected(),
    startAsk: unexpected,
    respondToSubmit: unexpected,
    cancelAsk: unexpected,
    executeWorldRead: async () => unexpected(),
  };
}

test("harness initial permission denial precedes engine/journal creation and VM entry writes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "uwork-harness-denied-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const journal = new InMemoryJournalStore();
  let drivers = 0;
  await assert.rejects(
    runWorkflowScript({
      cwd,
      runId: "controlled-denied",
      scriptText: "return 1;",
      caps: { maxConcurrency: 1 },
      askSpecs: new Map(),
      validate,
      makeDriver: () => {
        drivers++;
        return driver(journal);
      },
      beforePrepare: async () => {
        throw new Error("enterprise_filesystem_denied");
      },
    }),
    /enterprise_filesystem_denied/,
  );
  assert.equal(drivers, 0);
  assert.equal(journal.getRun("controlled-denied"), undefined);
  assert.deepEqual(await readdir(cwd), []);
});

test("harness permission denial after entry preparation is errored and never downgraded to interrupted", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "uwork-harness-spawn-denied-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const journal = new InMemoryJournalStore();
  const result = await runWorkflowScript({
    cwd,
    runId: "controlled-spawn-denied",
    scriptText: "return 1;",
    caps: { maxConcurrency: 1 },
    askSpecs: new Map(),
    validate,
    makeDriver: () => driver(journal),
    beforeSpawn: async () => {
      throw new Error("enterprise_identity_changed");
    },
  });
  assert.equal(result.status, "errored");
  assert.equal(journal.getRun("controlled-spawn-denied")?.status, "errored");
  if (result.status === "errored")
    assert.match(result.error.message, /enterprise_identity_changed/);
});

test("harness cancellation discards an uncooperative late beforePrepare allow without creating a run", async () => {
  const abort = new AbortController();
  let release!: () => void,
    reached!: () => void,
    drivers = 0;
  const atGate = new Promise<void>((done) => {
    reached = done;
  });
  const pending = runWorkflowScript({
    signal: abort.signal,
    runId: "controlled-cancelled",
    scriptText: "return 1;",
    caps: { maxConcurrency: 1 },
    askSpecs: new Map(),
    validate,
    makeDriver: () => {
      drivers++;
      return driver(new InMemoryJournalStore());
    },
    beforePrepare: () => {
      reached();
      return new Promise((done) => {
        release = done;
      });
    },
  });
  await atGate;
  abort.abort("model");
  const result = await pending;
  assert.deepEqual(result, { status: "stopped", reason: "model" });
  release();
  assert.equal(drivers, 0);
});
