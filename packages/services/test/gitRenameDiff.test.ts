import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { createGitService } from "../src/git/gitService.js";

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uwork-rename-diff-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-C", root, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      })
    ).stdout;
  await git("init", "--quiet");
  await git("config", "user.name", "Owned diff");
  await git("config", "user.email", "owned@example.test");
  await git("config", "commit.gpgsign", "false");
  const before = "original\n" + "same line\n".repeat(20);
  const oldPath = "old\t中文 name.txt";
  const newPath = "new\t中文 name.txt";
  await writeFile(join(root, oldPath), before);
  await git("add", "--", oldPath);
  await git("commit", "--quiet", "-m", "baseline");
  await git("branch", "-M", "main");
  await git("branch", "owned-base");
  await git("branch", "--set-upstream-to=owned-base", "main");
  await git("mv", "--", oldPath, newPath);
  return { root, git, oldPath, newPath, before, service: createGitService() };
}

for (const edited of [false, true]) {
  test(`staged ${edited ? "edited" : "pure"} rename reads both real versions without modifying Git`, async (t) => {
    const f = await fixture(t);
    const after = edited ? f.before.replace("original", "changed") : f.before;
    if (edited) {
      await writeFile(join(f.root, f.newPath), after);
      await f.git("add", "--", f.newPath);
    }
    const index = await f.git("diff", "--cached", "--binary");
    const diff = await f.service.getDiff({
      workspacePath: f.root,
      path: f.newPath,
      sourceId: "staged",
    });
    assert.equal(diff.beforeContent, f.before);
    assert.equal(diff.afterContent, after);
    assert.match(diff.patch!, /rename from/);
    assert.doesNotMatch(diff.patch!, /new file mode/);
    assert.equal(await f.git("diff", "--cached", "--binary"), index);
    assert.equal(await readFile(join(f.root, f.newPath), "utf8"), after);
  });
}

test("unstaged modification after staged rename reads index new path rather than HEAD old path", async (t) => {
  const f = await fixture(t);
  const after = f.before.replace("original", "worktree");
  await writeFile(join(f.root, f.newPath), after);
  const diff = await f.service.getDiff({
    workspacePath: f.root,
    path: f.newPath,
    sourceId: "unstaged",
  });
  assert.equal(diff.beforeContent, f.before);
  assert.equal(diff.afterContent, after);
  assert.doesNotMatch(diff.patch!, /rename from|new file mode/);
});

test("branch rename compares merge-base old path with HEAD new path", async (t) => {
  const f = await fixture(t);
  await f.git("commit", "--quiet", "-m", "rename");
  const diff = await f.service.getDiff({
    workspacePath: f.root,
    path: f.newPath,
    sourceId: "branch",
  });
  assert.equal(diff.beforeContent, f.before);
  assert.equal(diff.afterContent, f.before);
  assert.match(diff.patch!, /rename from/);
});

test("binary rename and missing working file keep honest patch fallback", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, f.newPath), Buffer.from([0, 1, 2]));
  await f.git("add", "--", f.newPath);
  const binary = await f.service.getDiff({
    workspacePath: f.root,
    path: f.newPath,
    sourceId: "staged",
  });
  assert.equal(binary.availability, "binary");
  assert.equal(binary.beforeContent, null);
  assert.equal(binary.afterContent, null);
  await rm(join(f.root, f.newPath));
  const missing = await f.service.getDiff({
    workspacePath: f.root,
    path: f.newPath,
    sourceId: "unstaged",
  });
  assert.equal(missing.beforeContent, null);
  assert.equal(missing.afterContent, null);
});
