import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  fixture,
  observe,
  pauseAfter,
  exists,
  outcome,
  originalFS,
  deferred,
} from "./fixtures/skillManagement.js";

test("allowed and unmanaged toggle controls persist through the one original writer", async (t) => {
  for (const unmanaged of [false, true])
    await t.test(unmanaged ? "unmanaged" : "managed allowed", async (t) => {
      const f = await fixture(t, false, unmanaged);
      await f.service.setEnabled({
        workspacePath: f.workspacePath,
        skillId: f.skillId,
        enabled: false,
      });
      const config = JSON.parse(await originalFS.readFile(f.configPath, "utf8"));
      assert.equal(config.skills[f.source].enable, false);
      assert.equal(config.sentinel, "preserve");
      if (unmanaged) assert.equal(f.requests(), 0);
    });
});

test("stale allowed list cannot authorize setEnabled after any skill policy switch denies", async (t) => {
  for (const mode of ["personal", "dangerous", "filesystem"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t),
        beforeRequests = f.requests();
      let lateContentReads = 0;
      observe(t, "readFile", (args) => {
        if (String(args[0]) === f.source) lateContentReads++;
      });
      f.revoke(mode);
      const result = await outcome(
        f.service.setEnabled({
          workspacePath: f.workspacePath,
          skillId: f.skillId,
          enabled: false,
        }),
      );
      const unchanged = (await originalFS.readFile(f.configPath, "utf8")) === f.initialConfig;
      assert.equal(unchanged, true, "denied management must not persist an override");
      assert.match(result, /^enterprise_/);
      assert.equal(lateContentReads, 0);
      assert.ok(f.requests() > beforeRequests, "the current policy must be read again");
    });
});

test("initial denial continues to protect copy remove and delete through shared admission", async (t) => {
  for (const method of ["copyToCommon", "removeFromCommon", "deleteSkill"] as const)
    await t.test(method, async (t) => {
      const f = await fixture(t, method === "removeFromCommon");
      f.revoke("personal");
      const result = await outcome(
        f.service[method]({ workspacePath: f.workspacePath, skillId: f.skillId }),
      );
      assert.match(result, /^enterprise_personal_skills_denied$/);
      assert.equal(await originalFS.readFile(f.source, "utf8"), f.body);
      if (method === "copyToCommon") assert.equal(await exists(f.target), false);
    });
});

test("a queued toggle cannot adopt a new owner or filesystem denial while the earlier write settles", async (t) => {
  for (const mode of ["owner", "filesystem"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      let writes = 0;
      const gate = pauseAfter(
        t,
        "writeFile",
        (args) => String(args[0]) === f.configPath && ++writes === 1,
      );
      const first = outcome(
        f.service.setEnabled({
          workspacePath: f.workspacePath,
          skillId: f.skillId,
          enabled: false,
        }),
      );
      await gate.entered();
      const acceptedBytes = await originalFS.readFile(f.configPath, "utf8");
      const second = outcome(
        f.service.setEnabled({ workspacePath: f.workspacePath, skillId: f.skillId, enabled: true }),
      );
      // Drain the real fixture session's microtask-only capture before revocation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      f.revoke(mode);
      gate.release();
      const firstResult = await first,
        result = await second;
      const preserved = (await originalFS.readFile(f.configPath, "utf8")) === acceptedBytes;
      assert.equal(
        preserved,
        true,
        "the queued operation must not overwrite the earlier admitted effect",
      );
      assert.match(result, /^enterprise_/);
      assert.match(firstResult, /^enterprise_/);
      assert.equal(writes, 1);
    });
});

test("copy cannot dispatch recursive copy after a real parent mkdir settles with revoked rights", async (t) => {
  for (const mode of ["personal", "filesystem", "owner"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const gate = pauseAfter(t, "mkdir", (args) => String(args[0]) === f.commonRoot);
      const pending = outcome(
        f.service.copyToCommon({ workspacePath: f.workspacePath, skillId: f.skillId }),
      );
      await gate.entered();
      f.revoke(mode);
      gate.release();
      const result = await pending,
        copied = await exists(f.target);
      assert.equal(copied, false, "revocation after mkdir must prevent the subsequent cp dispatch");
      assert.match(result, /^enterprise_/);
    });
});

test("delete cannot dispatch rm after an authorized list and awaited canonical-parent metadata revoke", async (t) => {
  for (const mode of ["personal", "filesystem", "owner"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      let bodyRead = false,
        listConfigRead = false,
        removals = 0;
      observe(t, "readFile", (args) => {
        if (String(args[0]) === f.source) bodyRead = true;
        if (bodyRead && String(args[0]) === f.configPath) listConfigRead = true;
      });
      observe(t, "rm", (args) => {
        if (String(args[0]) === f.sourceDir) removals++;
      });
      const gate = pauseAfter(
        t,
        "realpath",
        (args) => String(args[0]) === dirname(f.sourceDir) && listConfigRead,
      );
      const pending = outcome(
        f.service.deleteSkill({ workspacePath: f.workspacePath, skillId: f.skillId }),
      );
      await gate.entered();
      f.revoke(mode);
      gate.release();
      const result = await pending,
        retained = await exists(f.source);
      assert.equal(bodyRead && listConfigRead, true);
      assert.equal(removals, 0);
      assert.equal(retained, true, "revocation after metadata must prevent subsequent rm dispatch");
      assert.match(result, /^enterprise_/);
    });
});

test("remove may finish its already admitted rm but cannot publish stale success after rm settles", async (t) => {
  for (const mode of ["filesystem", "owner"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t, true);
      const gate = pauseAfter(t, "rm", (args) => String(args[0]) === f.sourceDir);
      const pending = outcome(
        f.service.removeFromCommon({ workspacePath: f.workspacePath, skillId: f.skillId }),
      );
      await gate.entered();
      const removedWhileAllowed = !(await exists(f.source));
      f.revoke(mode);
      gate.release();
      const result = await pending;
      assert.equal(
        removedWhileAllowed,
        true,
        "the rm had already completed while authorized; this is not late dispatch",
      );
      assert.match(
        result,
        /^enterprise_/,
        "the old owner/policy must not publish success after the wait",
      );
    });
});

test("a capture/entry-denied second toggle cannot release a third before the first physical write settles", async (t) => {
  for (const mode of ["capture", "entry"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      let writes = 0;
      const gate = pauseAfter(
        t,
        "writeFile",
        (args) => String(args[0]) === f.configPath && ++writes === 1,
      );
      const first = outcome(
        f.service.setEnabled({
          workspacePath: f.workspacePath,
          skillId: f.skillId,
          enabled: false,
        }),
      );
      await gate.entered();
      const captured = deferred();
      let failOnce = true;
      if (mode === "capture")
        f.configPause(async () => {
          if (!failOnce) return;
          failOnce = false;
          captured.resolve();
          throw new Error("owned configuration-read failure");
        });
      else f.revoke("filesystem");
      const secondDecision = mode === "capture" ? captured.promise : f.nextPolicy();
      const second = outcome(
        f.service.setEnabled({ workspacePath: f.workspacePath, skillId: f.skillId, enabled: true }),
      );
      await secondDecision;
      f.configPause(undefined);
      f.allow();
      const thirdDecision = f.nextPolicy();
      const third = outcome(
        f.service.setEnabled({ workspacePath: f.workspacePath, skillId: f.skillId, enabled: true }),
      );
      await thirdDecision;
      const beforeRelease = await Promise.race([
        third.then(() => "third completed early"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still queued"), 60)),
      ]);
      assert.equal(beforeRelease, "still queued");
      assert.equal(
        writes,
        1,
        "only the first already admitted physical write may exist before release",
      );
      assert.equal(
        JSON.parse(await originalFS.readFile(f.configPath, "utf8")).skills[f.source].enable,
        false,
      );
      gate.release();
      assert.equal(await first, "success");
      assert.equal(
        await second,
        mode === "capture" ? "enterprise_policy_unavailable" : "enterprise_filesystem_denied",
      );
      assert.equal(await third, "success");
      assert.equal(writes, 2);
      assert.equal(JSON.parse(await originalFS.readFile(f.configPath, "utf8")).skills, undefined);
    });
});

test("allowed management preserves the original copy delete and remove effects", async (t) => {
  for (const method of ["copyToCommon", "deleteSkill", "removeFromCommon"] as const)
    await t.test(method, async (t) => {
      const f = await fixture(t, method === "removeFromCommon");
      const result = await f.service[method]({
        workspacePath: f.workspacePath,
        skillId: f.skillId,
      });
      if (method === "copyToCommon") {
        assert.deepEqual(result, { newPath: f.target });
        assert.equal(await originalFS.readFile(f.target, "utf8"), f.body);
        assert.equal(await originalFS.readFile(f.source, "utf8"), f.body);
      } else assert.equal(await exists(f.source), false);
    });
});

test("read fallbacks cannot swallow policy denial after fulfilled or rejected content/config/metadata IO", async (t) => {
  for (const kind of ["body", "config", "metadata", "user-name-key"] as const)
    for (const rejected of [false, true])
      await t.test(`${kind} ${rejected ? "rejected" : "fulfilled"}`, async (t) => {
        const f = await fixture(t);
        let path = kind === "config" ? f.configPath : f.source;
        if (kind === "metadata") {
          path = join(f.sourceDir, "_meta.json");
          await fs.writeFile(path, JSON.stringify({ slug: "owned" }));
        } else if (kind === "user-name-key") {
          path = join(f.root, "storage", "skills", "owned-user", "SKILL.md");
          await fs.mkdir(dirname(path), { recursive: true });
          await fs.writeFile(
            path,
            "---\nname: owned-user\ndescription: owned\n---\nowned user body\n",
          );
        }
        let hits = 0;
        observe(t, "readFile", (args) => {
          if (String(args[0]) !== path) return;
          hits++;
          f.revoke("personal");
          if (rejected) throw new Error("private failed IO detail");
        });
        await assert.rejects(
          f.service.list({ workspacePath: f.workspacePath }),
          /enterprise_personal_skills_denied/,
        );
        assert.equal(hits, 1);
      });
});

test("policy denial after the final config merge read prevents the toggle write", async (t) => {
  const f = await fixture(t);
  let reads = 0,
    writes = 0;
  observe(t, "readFile", (args) => {
    if (String(args[0]) === f.configPath && ++reads === 3) f.revoke("filesystem");
  });
  observe(t, "writeFile", (args) => {
    if (String(args[0]) === f.configPath) writes++;
  });
  await assert.rejects(
    f.service.setEnabled({ workspacePath: f.workspacePath, skillId: f.skillId, enabled: false }),
    /enterprise_filesystem_denied/,
  );
  assert.equal(reads, 3);
  assert.equal(writes, 0);
  assert.equal(await originalFS.readFile(f.configPath, "utf8"), f.initialConfig);
});

test("prompt audit mkdir cannot authorize a later append after revocation", async (t) => {
  const f = await fixture(t);
  const auditRoot = join(f.root, "data", ".uwork", "v2");
  const gate = pauseAfter(t, "mkdir", (args) => String(args[0]) === auditRoot);
  let appends = 0;
  observe(t, "appendFile", () => {
    appends++;
  });
  const pending = outcome(
    f.service.buildPromptContext({ workspacePath: f.workspacePath, prompt: "$controlled" }),
  );
  await gate.entered();
  f.revoke("personal");
  gate.release();
  assert.equal(await pending, "enterprise_personal_skills_denied");
  assert.equal(appends, 0);
  assert.equal(await exists(join(auditRoot, "skills-audit.log")), false);
});

test("malformed current backend policy fails before management IO", async (t) => {
  const f = await fixture(t);
  f.respond({ allowed: true, tenantId: "tenant", personal: { skills: true } });
  let reads = 0,
    writes = 0;
  observe(t, "readFile", (args) => {
    if (String(args[0]) === f.source) reads++;
  });
  observe(t, "writeFile", (args) => {
    if (String(args[0]) === f.configPath) writes++;
  });
  await assert.rejects(
    f.service.setEnabled({ workspacePath: f.workspacePath, skillId: f.skillId, enabled: false }),
    /enterprise_policy_unavailable/,
  );
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test("delete removes an imported symlink leaf and preserves its real target", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "external", "SKILL.md");
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, f.body);
  await fs.rm(f.sourceDir, { recursive: true });
  await fs.symlink(dirname(target), f.sourceDir);
  const skill = (await f.service.list({ workspacePath: f.workspacePath })).skills.find(
    (item) => item.sourcePath === f.source,
  );
  assert(skill);
  await f.service.deleteSkill({ workspacePath: f.workspacePath, skillId: skill.id });
  assert.equal(await exists(f.sourceDir), false);
  assert.equal(await originalFS.readFile(target, "utf8"), f.body);
});

test("all management methods clone input before authorization waits", async (t) => {
  for (const method of ["setEnabled", "copyToCommon", "deleteSkill", "removeFromCommon"] as const)
    await t.test(method, async (t) => {
      const f = await fixture(t, method === "removeFromCommon"),
        entered = deferred(),
        release = deferred();
      let first = true;
      f.configPause(async () => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
      });
      t.after(release.resolve);
      const params = { workspacePath: f.workspacePath, skillId: f.skillId, enabled: false };
      const pending = f.service[method](params);
      await entered.promise;
      params.workspacePath = "/unowned/never-written";
      params.skillId = "changed";
      params.enabled = true;
      release.resolve();
      const result = await pending;
      if (method === "setEnabled")
        assert.equal(
          JSON.parse(await originalFS.readFile(f.configPath, "utf8")).skills[f.source].enable,
          false,
        );
      else if (method === "copyToCommon") assert.deepEqual(result, { newPath: f.target });
      else assert.equal(await exists(f.source), false);
    });
});

test("HTTP policy failure cannot dispatch management reads or writes", async (t) => {
  const f = await fixture(t);
  f.respond({ private: "owned upstream diagnostic" }, 503);
  let reads = 0,
    writes = 0;
  observe(t, "readFile", () => {
    reads++;
  });
  observe(t, "writeFile", () => {
    writes++;
  });
  await assert.rejects(
    f.service.setEnabled({ workspacePath: f.workspacePath, skillId: f.skillId, enabled: false }),
    /enterprise_policy_unavailable/,
  );
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test("delete refuses an ancestor symlink escape and leaves its target intact", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.sourceDir, { recursive: true });
  const external = join(f.root, "external", "controlled", "SKILL.md");
  await fs.mkdir(dirname(external), { recursive: true });
  await fs.writeFile(external, f.body);
  await fs.symlink(dirname(dirname(external)), join(dirname(f.sourceDir), "group"));
  const skill = (await f.service.list({ workspacePath: f.workspacePath })).skills.find(
    (item) => item.path === external,
  );
  assert(skill);
  await assert.rejects(
    f.service.deleteSkill({ workspacePath: f.workspacePath, skillId: skill.id }),
    /enterprise_skill_management_failed/,
  );
  assert.equal(await originalFS.readFile(external, "utf8"), f.body);
});
