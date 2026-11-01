import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedFilesFromGit } from "../architecture/index.mjs";

test("architecture changes in a vendored workspace stay relative and exclude sibling sources", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "uwork-git-workspace-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const workspace = join(repository, "clients", "uwork");
  await mkdir(join(workspace, "packages", "test"), { recursive: true });
  await writeFile(join(repository, "outside.ts"), "original\n");
  await writeFile(join(workspace, "packages", "test", "有 空格.ts"), "original\n");
  const git = (...args) => execFileSync("git", args, { cwd: repository, stdio: "pipe" });
  git("init", "--quiet");
  git("add", "outside.ts", "clients/uwork/packages/test/有 空格.ts");
  git(
    "-c",
    "user.name=Controlled Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  await writeFile(join(repository, "outside.ts"), "changed outside\n");
  await writeFile(join(repository, "outside-new.ts"), "new outside\n");
  await writeFile(join(workspace, "packages", "test", "有 空格.ts"), "changed inside\n");
  await writeFile(join(workspace, "packages", "test", "new.ts"), "new inside\n");
  assert.deepEqual((await changedFilesFromGit(workspace)).sort(), [
    "packages/test/new.ts",
    "packages/test/有 空格.ts",
  ]);
});
