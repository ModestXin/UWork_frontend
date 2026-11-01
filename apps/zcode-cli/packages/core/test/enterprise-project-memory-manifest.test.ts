import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionId } from "@zcode/contracts";
import {
  manifestFixture,
  DESCRIPTION,
  PROMPT,
} from "./enterprise-project-memory-manifest.fixture.js";
const leaked = (value: unknown) => JSON.stringify(value).includes(DESCRIPTION);

test(
  "actual Runtime natural extraction with filesystem=false reads no manifest and leaks no topic description",
  { timeout: 5000 },
  async (t) => {
    const f = await manifestFixture(t);
    f.state.allowed = false;
    assert.equal(PROMPT.split(/\s+/).length, 3);
    assert.ok(!PROMPT.includes(DESCRIPTION));
    await f.turn();
    await f.drain();
    assert.equal(f.requests.length >= 1, true, "plain main execution remains valid");
    const durable = await f.store.messages({ sessionID: f.id });
    assert.deepEqual(
      durable.map((m) => m.info.role),
      ["user", "assistant"],
    );
    assert.deepEqual(
      { listings: f.state.listings, topicReads: f.state.topicReads, leaked: leaked(f.requests) },
      { listings: 0, topicReads: 0, leaked: false },
    );
    assert.equal(f.sidecars().length, 0);
    assert.equal(
      f.internal.memoryExtractionScheduler?.getCursor(),
      undefined,
      "denied manifest is not a successful extraction cursor",
    );
  },
);

test(
  "actual allowed natural scheduler sidecar consumes existing topic description from real owned range read",
  { timeout: 5000 },
  async (t) => {
    const f = await manifestFixture(t);
    await f.turn();
    await f.drain();
    assert.equal(f.state.listings, 1);
    assert.equal(f.state.topicReads, 1);
    assert.equal(f.requests.length, 2);
    assert.equal(f.sidecars().length, 1);
    assert.ok(!leaked(f.requests[0]));
    assert.ok(leaked(f.sidecars()[0]));
    const durable = await f.store.messages({ sessionID: f.id });
    assert.deepEqual(
      durable.map((m) => m.info.role),
      ["user", "assistant"],
    );
    assert.ok(!leaked(durable), "extraction prompt is not persisted as a user conversation input");
    assert.equal(f.internal.memoryExtractionScheduler?.getCursor(), durable.at(-1)?.info.id);
  },
);

test(
  "manifest uses its own fixed internal dispatch/result owner proof without file metadata",
  { timeout: 5000 },
  async (t) => {
    const f = await manifestFixture(t);
    await f.turn();
    await f.drain();
    const admissions = f.admissions.filter((r) => r.toolName === "ProjectMemoryManifestRead");
    assert.deepEqual(
      admissions.map((r) => r.phase),
      ["before_dispatch", "before_result"],
    );
    for (const r of admissions) {
      assert.deepEqual(r.input, { kind: "project-memory-manifest" });
      assert.deepEqual(r.capability, {
        permission: "filesystem",
        sideEffectScope: "none",
        readOnly: true,
        destructive: false,
      });
    }
    assert.equal(admissions[0].toolCallId, admissions[1].toolCallId);
    assert.equal(admissions[0].ownerKey, undefined);
    assert.equal(admissions[1].ownerKey, "a".repeat(64));
  },
);

for (const change of [
  "revoke",
  "owner",
  "replace-port",
  "remove-port",
  "unmanaged",
  "session",
  "workspace-root",
  "memory-root",
  "filesystem-port",
] as const)
  test(
    `actual topic scan await ${change} withholds description before sidecar model dispatch`,
    { timeout: 5000 },
    async (t) => {
      const f = await manifestFixture(t);
      f.state.holdRead = true;
      await f.turn();
      await f.entered.promise;
      assert.equal(f.requests.length, 1, "only main completed before the actual scan read barrier");
      if (change === "revoke") f.state.allowed = false;
      if (change === "owner") f.state.ownerKey = "b".repeat(64);
      if (change === "replace-port")
        f.setPort({ authorize: f.authorization.authorize.bind(f.authorization) });
      if (change === "remove-port") f.setPort();
      if (change === "unmanaged") f.state.managed = false;
      if (change === "session")
        Object.defineProperty(f.runtime, "sessionId", {
          configurable: true,
          value: createSessionId("replacement-session"),
        });
      if (change === "workspace-root") f.internal.workspaceRoot = f.otherOwnedCwd;
      if (change === "memory-root") f.internal.memoryRoot = f.otherOwnedCwd;
      if (change === "filesystem-port") f.internal.fileSystemPort = f.newFileSystem();
      f.release.resolve();
      await f.drain();
      assert.equal(f.state.topicReads, 1);
      assert.ok(!leaked(f.requests));
      assert.equal(f.sidecars().length, 0);
      assert.equal(f.internal.memoryExtractionScheduler?.getCursor(), undefined);
    },
  );

for (const unmanaged of ["absent", "explicit"] as const)
  test(
    `actual ${unmanaged} manifest scan preserves standalone behavior`,
    { timeout: 5000 },
    async (t) => {
      const f = await manifestFixture(t, unmanaged);
      await f.turn();
      await f.drain();
      assert.equal(f.sidecars().length, 1);
      assert.ok(leaked(f.sidecars()[0]));
      assert.equal(f.state.topicReads, 1);
    },
  );

test(
  "standalone scan cannot publish after a managed port appears during actual owned read",
  { timeout: 5000 },
  async (t) => {
    const f = await manifestFixture(t, "absent");
    f.state.holdRead = true;
    await f.turn();
    await f.entered.promise;
    f.setPort(f.authorization);
    f.release.resolve();
    await f.drain();
    assert.ok(!leaked(f.requests));
    assert.equal(f.sidecars().length, 0);
    assert.equal(f.internal.memoryExtractionScheduler?.getCursor(), undefined);
  },
);

test(
  "original scheduler shutdown races uncooperative manifest read and late bytes never dispatch",
  { timeout: 5000 },
  async (t) => {
    const f = await manifestFixture(t);
    f.state.holdRead = true;
    await f.turn();
    await f.entered.promise;
    f.runtime.beginShutdown();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = f.drain().then(() => true);
    const beforeRelease = await Promise.race([
      finished,
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), 100);
      }),
    ]);
    if (timer) clearTimeout(timer);
    f.release.resolve();
    await finished;
    assert.ok(!leaked(f.requests));
    assert.equal(f.sidecars().length, 0);
    assert.equal(
      beforeRelease,
      true,
      "public drain must settle on original scheduler abort before uncooperative late bytes return",
    );
    assert.equal(f.internal.memoryExtractionScheduler?.getCursor(), undefined);
  },
);

test(
  "later Main live cwd changes preserve the original background snapshot and admission scope",
  { timeout: 5000 },
  async (t) => {
    const f = await manifestFixture(t);
    f.state.holdRead = true;
    await f.turn();
    await f.entered.promise;
    f.internal.workingDirectory = f.otherOwnedCwd;
    f.release.resolve();
    await f.drain();
    assert.equal(
      f.sidecars().length,
      1,
      "a legitimate Main cd must not cancel captured extraction",
    );
    assert.ok(leaked(f.sidecars()[0]));
    const serialized = JSON.stringify(f.sidecars()[0].messages);
    assert.ok(serialized.includes("- Primary working directory: " + f.workspace));
    assert.ok(!serialized.includes("- Primary working directory: " + f.otherOwnedCwd));
    assert.equal(f.internal.workspaceRoot, f.workspace);
    const admissions = f.admissions.filter((r) => r.toolName === "ProjectMemoryManifestRead");
    assert.deepEqual(
      admissions.map((r) => r.phase),
      ["before_dispatch", "before_result"],
    );
    for (const request of admissions) {
      assert.equal(request.workingDirectory, f.workspace);
      assert.equal(request.workspacePath, f.workspace);
    }
  },
);
