import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createRootTraceContext, type SkillMetadata } from "@zcode/contracts";
import { fixture, MARKER } from "./enterprise-project-memory-runtime.fixture.js";

const contains = (value: unknown) => JSON.stringify(value).includes(MARKER);
function withheld(f: ReturnType<typeof fixture>) {
  assert.ok(!contains(f.requests), "fresh Memory bytes must not enter an actual model request");
  assert.ok(!f.snapshot().includes(MARKER), "no new Memory bytes in context/history/readFileState");
}

test(
  "actual Runtime denies fresh index before reading but preserves plain text execution",
  { timeout: 3000 },
  async (t) => {
    const f = fixture(t);
    f.state.allowed = false;
    await f.turn();
    assert.equal(
      f.state.reads,
      0,
      "filesystem denial must precede index read; directory setup is separate IO",
    );
    assert.equal(f.requests.length, 1);
    withheld(f);
  },
);

const SKILL_MARKER = "PENDING_SKILL_METADATA_FROM_PREVIOUS_OWNER";
function addPendingSkill(f: ReturnType<typeof fixture>) {
  const directory = join(f.internal.workingDirectory, ".agents", "skills", "owned");
  const skill: SkillMetadata = {
    name: SKILL_MARKER,
    description: "Controlled metadata awaiting the final context owner check",
    path: join(directory, "SKILL.md"),
    directory,
    rootPath: join(f.internal.workingDirectory, ".agents", "skills"),
    scope: "project",
    source: "agents",
    safeToAutoLoad: false,
    frontmatterKeys: ["name", "description"],
  };
  f.state.skills.push(skill);
}
function assertNoPendingSkill(f: ReturnType<typeof fixture>) {
  assert.ok(!JSON.stringify(f.internal.skillLoadOutcome ?? null).includes(SKILL_MARKER));
  assert.ok(!JSON.stringify(f.internal.buildSkillUsageDetails()).includes(SKILL_MARKER));
  assert.ok(!JSON.stringify(f.requests).includes(SKILL_MARKER));
  assert.ok(!f.snapshot().includes(SKILL_MARKER));
}

test(
  "actual pending Skill metadata stays private while final Memory authority waits",
  { timeout: 3000 },
  async (t) => {
    const f = fixture(t);
    addPendingSkill(f);
    f.controls.holdAuthority = true;
    const pending = f.turn();
    await f.entered.authority.promise;
    assertNoPendingSkill(f);
    f.release.authority.resolve();
    await pending;
    assert.equal(f.requests.length, 1);
    assert.ok(JSON.stringify(f.internal.skillLoadOutcome).includes(SKILL_MARKER));
    assert.ok(JSON.stringify(f.internal.buildSkillUsageDetails()).includes(SKILL_MARKER));
  },
);

test(
  "failed final owner proof leaves no pending Skill in Runtime fields, usage or history",
  { timeout: 3000 },
  async (t) => {
    const f = fixture(t);
    addPendingSkill(f);
    f.controls.holdAuthority = true;
    const pending = f.turn();
    await f.entered.authority.promise;
    f.state.ownerKey = "b".repeat(64);
    f.release.authority.resolve();
    await assert.rejects(pending);
    assertNoPendingSkill(f);
    withheld(f);
    assert.equal(f.requests.length, 0);
    assert.equal(f.internal.contextInitialized, false);
  },
);

for (const readMode of ["missing", "empty", "unreadable"] as const)
  test(
    `actual ${readMode} index retains owner proof across later Skill discovery`,
    { timeout: 3000 },
    async (t) => {
      const f = fixture(t);
      addPendingSkill(f);
      f.state.readMode = readMode;
      f.controls.holdSkills = true;
      const pending = f.turn();
      await f.entered.skills.promise;
      f.state.ownerKey = "b".repeat(64);
      f.release.skills.resolve();
      await assert.rejects(
        pending,
        "a no-body result cannot drop the original context owner fence",
      );
      assertNoPendingSkill(f);
      withheld(f);
      assert.equal(f.state.reads, 1);
      assert.equal(f.requests.length, 0);
      assert.equal(f.internal.contextInitialized, false);
    },
  );

test(
  "normal missing, empty and unreadable indexes preserve plain text and accepted Skill metadata",
  { timeout: 3000 },
  async (t) => {
    for (const readMode of ["missing", "empty", "unreadable"] as const) {
      const f = fixture(t);
      addPendingSkill(f);
      f.state.readMode = readMode;
      await f.turn();
      assert.equal(f.requests.length, 1);
      assert.ok(JSON.stringify(f.internal.skillLoadOutcome).includes(SKILL_MARKER));
      assert.ok(JSON.stringify(f.internal.buildSkillUsageDetails()).includes(SKILL_MARKER));
      withheld(f);
      assert.deepEqual(
        f.admissions.map((a) => a.phase),
        ["before_dispatch", "before_result"],
      );
    }
  },
);

for (const code of [
  "enterprise_identity_changed",
  "enterprise_configuration_changed",
  "enterprise_authorization_cancelled",
] as const)
  test(
    `initial Memory admission ${code} invalidates the whole pending context`,
    { timeout: 3000 },
    async (t) => {
      const f = fixture(t);
      addPendingSkill(f);
      f.state.dispatchCode = code;
      await assert.rejects(
        f.turn(),
        "stable Host owner/lifecycle failure is not a plain Memory-policy omission",
      );
      assert.equal(f.state.reads, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.internal.contextInitialized, false);
      assertNoPendingSkill(f);
      withheld(f);
    },
  );

for (const unmanaged of [false, "absent", "explicit"] as const)
  test(
    `actual Runtime retains allowed Memory context for ${unmanaged === false ? "managed" : unmanaged}`,
    { timeout: 3000 },
    async (t) => {
      const f = fixture(t, unmanaged);
      await f.turn();
      assert.equal(f.state.reads, 1);
      assert.ok(contains(f.requests));
      assert.ok(f.snapshot().includes(MARKER));
      if (unmanaged === false)
        assert.deepEqual(
          f.admissions.map((a) => a.phase),
          ["before_dispatch", "before_result"],
        );
    },
  );

for (const change of [
  "deny",
  "owner",
  "remove-port",
  "replace-port",
  "unmanaged",
  "missing-owner",
  "skill-port",
  "workspace",
] as const)
  test(`actual Runtime withholds read result after ${change}`, { timeout: 3000 }, async (t) => {
    const f = fixture(t);
    f.controls.holdRead = true;
    const pending = f.turn();
    await f.entered.read.promise;
    if (change === "deny") f.state.allowed = false;
    if (change === "owner") f.state.ownerKey = "b".repeat(64);
    if (change === "remove-port") f.setPort();
    if (change === "replace-port")
      f.setPort({ authorize: f.authorization.authorize.bind(f.authorization) });
    if (change === "unmanaged") f.state.managed = false;
    if (change === "missing-owner") f.state.ownerKey = undefined;
    if (change === "skill-port")
      Object.defineProperty(f.runtime, "skillPort", {
        configurable: true,
        value: { ...f.skillPort },
      });
    if (change === "workspace")
      f.internal.workingDirectory = join(f.internal.workingDirectory, "replacement");
    f.release.read.resolve();
    if (change === "deny") await pending;
    else await pending.catch(() => {});
    assert.equal(f.state.reads, 1);
    withheld(f);
  });

test("standalone read cannot become managed while its IO waits", { timeout: 3000 }, async (t) => {
  const f = fixture(t, "absent");
  f.controls.holdRead = true;
  const pending = f.turn();
  await f.entered.read.promise;
  f.setPort(f.authorization);
  f.release.read.resolve();
  await pending.catch(() => {});
  withheld(f);
});

test(
  "Memory remains pending until guarded Skill discovery completes, then current denial withholds it",
  { timeout: 3000 },
  async (t) => {
    const f = fixture(t);
    f.controls.holdSkills = true;
    const pending = f.turn();
    await f.entered.skills.promise;
    const early = f.snapshot();
    f.state.allowed = false;
    f.release.skills.resolve();
    await pending;
    assert.ok(
      !early.includes(MARKER),
      "index/readFileState must not commit before the later Skills await",
    );
    withheld(f);
  },
);

for (const stage of ["context", "root", "read", "skills", "authority"] as const)
  test(
    `actual turn signal races uncooperative ${stage} and late bytes never commit`,
    { timeout: 3000 },
    async (t) => {
      const f = fixture(t);
      const controller = new AbortController();
      f.controls.holdContext = stage === "context";
      f.controls.holdRoot = stage === "root";
      f.controls.holdRead = stage === "read";
      f.controls.holdSkills = stage === "skills";
      f.controls.holdAuthority = stage === "authority";
      const pending = f.turn(controller.signal);
      const outcome = pending.then(
        () => true,
        () => true,
      );
      let entryTimer: ReturnType<typeof setTimeout> | undefined;
      const reached = await Promise.race([
        f.entered[stage].promise.then(() => true),
        new Promise<boolean>((resolve) => {
          entryTimer = setTimeout(() => resolve(false), 100);
        }),
      ]);
      if (entryTimer) clearTimeout(entryTimer);
      assert.equal(reached, true, "Actual Runtime must reach the controlled context boundary");
      controller.abort(Error("controlled cancellation"));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settledBeforeRelease = await Promise.race([
        outcome,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 100);
        }),
      ]);
      if (timer) clearTimeout(timer);
      f.release[stage].resolve();
      await outcome;
      assert.equal(
        settledBeforeRelease,
        true,
        "turn must cancel before noncooperative IO is released",
      );
      withheld(f);
    },
  );

test(
  "non-turn catalog initialization must not commit after existing beginShutdown flag",
  { timeout: 3000 },
  async (t) => {
    const f = fixture(t);
    f.controls.holdRead = true;
    const pending = f.runtime.getSkillCatalog(createRootTraceContext());
    f.pending.push(pending);
    await f.entered.read.promise;
    f.runtime.beginShutdown();
    f.release.read.resolve();
    await pending.catch(() => {});
    withheld(f);
  },
);
