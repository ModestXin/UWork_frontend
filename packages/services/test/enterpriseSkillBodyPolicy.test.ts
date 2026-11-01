import assert from "node:assert/strict";
import { test } from "node:test";
import { withPersonalSkillAccess } from "../src/skills/skillAccess.js";
import { fixture, observe, pauseAfter, deferred } from "./fixtures/skillManagement.js";

test("legacy Host list and prompt body outlets cannot bypass current personal skill policy", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  observe(t, "readFile", (args) => {
    if (String(args[0]) === f.source) reads++;
  });
  f.revoke("personal");
  await assert.rejects(
    f.service.list({ workspacePath: f.workspacePath }),
    /enterprise_personal_skills_denied/,
  );
  await assert.rejects(
    f.service.buildPromptContext({ workspacePath: f.workspacePath, prompt: "$controlled" }),
    /enterprise_personal_skills_denied/,
  );
  assert.equal(reads, 0);
  f.allow();
  assert.equal(
    (await f.service.list({ workspacePath: f.workspacePath })).skills[0]!.body,
    "owned fixture body",
  );
  assert.match(
    (await f.service.buildPromptContext({ workspacePath: f.workspacePath, prompt: "$controlled" }))
      .prompt,
    /owned fixture body/,
  );
});

test("logout and policy revocation after a legacy read discard both body-bearing results", async (t) => {
  for (const mode of ["logout", "owner", "personal", "filesystem"] as const)
    for (const prompt of [false, true])
      await t.test(`${mode} ${prompt ? "prompt" : "list"}`, async (t) => {
        const f = await fixture(t);
        let reads = 0;
        observe(t, "readFile", (args) => {
          if (String(args[0]) === f.source) {
            reads++;
            if (mode === "logout") f.logout();
            else f.revoke(mode);
          }
        });
        await assert.rejects(
          prompt
            ? f.service.buildPromptContext({
                workspacePath: f.workspacePath,
                prompt: "$controlled",
              })
            : f.service.list({ workspacePath: f.workspacePath }),
          (error: unknown) =>
            error instanceof Error &&
            error.message.startsWith("enterprise_") &&
            !error.message.includes("owned fixture body"),
        );
        assert.equal(reads, 1);
      });
});

test("unmanaged legacy Host outlets retain their original result without enterprise HTTP", async (t) => {
  const f = await fixture(t, false, true);
  assert.equal((await f.service.list({ workspacePath: f.workspacePath })).skills.length, 1);
  assert.match(
    (await f.service.buildPromptContext({ workspacePath: f.workspacePath, prompt: "$controlled" }))
      .prompt,
    /owned fixture body/,
  );
  assert.equal(f.requests(), 0);
});

test("unmanaged errors retain legacy semantics while managed read failures remain sanitized", async (t) => {
  for (const unmanaged of [false, true])
    await t.test(unmanaged ? "unmanaged" : "managed", async (t) => {
      const f = await fixture(t, false, unmanaged),
        failure = new Error("owned fixture body");
      await assert.rejects(
        withPersonalSkillAccess(
          f.backendSession,
          async () => {
            throw failure;
          },
          { readWork: true, failureCode: "enterprise_skill_read_failed" },
        ),
        (error: unknown) =>
          unmanaged
            ? error === failure
            : error instanceof Error && error.message === "enterprise_skill_read_failed",
      );
      if (unmanaged) assert.equal(f.requests(), 0);
    });
});

test("list and prompt clone params before their first authorization await", async (t) => {
  for (const prompt of [false, true])
    await t.test(prompt ? "prompt" : "list", async (t) => {
      const f = await fixture(t),
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
      const params = { workspacePath: f.workspacePath, prompt: "$controlled" };
      const pending = prompt ? f.service.buildPromptContext(params) : f.service.list(params);
      await entered.promise;
      params.workspacePath = "/unowned/never-read";
      params.prompt = "changed";
      release.resolve();
      const value = await pending;
      assert.match(JSON.stringify(value), /owned fixture body/);
      assert.doesNotMatch(JSON.stringify(value), /unowned\/never-read/);
    });
});

test("cancelled body work rejects without waiting for an uncooperative read or continuing to audit", async (t) => {
  for (const prompt of [false, true])
    await t.test(prompt ? "prompt" : "list", async (t) => {
      const f = await fixture(t);
      const gate = pauseAfter(t, "readFile", (args) => String(args[0]) === f.source);
      let mutations = 0;
      observe(t, "appendFile", () => {
        mutations++;
      });
      const pending = prompt
        ? f.service.buildPromptContext({ workspacePath: f.workspacePath, prompt: "$controlled" })
        : f.service.list({ workspacePath: f.workspacePath });
      const rejected = assert.rejects(
        pending,
        (error: unknown) => error instanceof Error && error.message.startsWith("enterprise_"),
      );
      await gate.entered();
      f.revoke("owner");
      await Promise.race([
        rejected,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("cancelled body read did not reject promptly")),
            2000,
          );
          timer.unref();
        }),
      ]);
      assert.equal(mutations, 0);
      gate.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(mutations, 0);
    });
});

test("body parameter clone errors retain their original error before managed sanitization", async (t) => {
  const f = await fixture(t),
    requests = f.requests();
  const invalid = { workspacePath: f.workspacePath, prompt: "$controlled", unsupported: () => {} };
  assert.throws(() => f.service.list(invalid), { name: "DataCloneError" });
  assert.throws(() => f.service.buildPromptContext(invalid), { name: "DataCloneError" });
  assert.equal(f.requests(), requests);
});
