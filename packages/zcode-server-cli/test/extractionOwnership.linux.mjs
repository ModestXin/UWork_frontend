import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { extractArchiveSafely } from "../src/runtime/componentCache.ts";

const execute = promisify(execFile);

test("Linux release extraction retains the installing uid without CAP_CHOWN", async () => {
  assert.equal(
    process.platform,
    "linux",
    "Run this contract in the owned Linux cap-drop container",
  );
  assert.equal(process.getuid(), 0);
  const capabilities = await readFile("/proc/self/status", "utf8");
  const effective = BigInt("0x" + capabilities.match(/^CapEff:\s*([0-9a-f]+)$/m)[1]);
  assert.equal(effective & 1n, 0n, "CAP_CHOWN must actually be unavailable");
  const scratch = await mkdtemp(join(tmpdir(), "uw-extraction-owner-"));
  try {
    const input = join(scratch, "input"),
      output = join(scratch, "output");
    await mkdir(input);
    await mkdir(output);
    await writeFile(join(input, "runner"), "original-release-body\n", { mode: 0o755 });
    const archive = join(scratch, "release.tar.gz");
    await execute("tar", ["--owner=501", "--group=50", "-czf", archive, "-C", input, "runner"]);
    const listing = await execute("tar", ["-tvzf", archive, "--numeric-owner"]);
    assert.match(listing.stdout, /501\/50/);
    await extractArchiveSafely(archive, output);
    assert.equal(await readFile(join(output, "runner"), "utf8"), "original-release-body\n");
    const installed = await stat(join(output, "runner"));
    assert.equal(installed.uid, process.getuid());
    assert.equal(installed.gid, process.getgid());
    assert.equal(installed.mode & 0o111, 0o111);
    await symlink("runner", join(input, "alias"));
    const links = join(scratch, "links.tar.gz");
    await execute("tar", ["-czf", links, "-C", input, "alias"]);
    await assert.rejects(extractArchiveSafely(links, output), /symbolic or hard link/);
    const traversal = join(scratch, "traversal.tar.gz");
    await execute("tar", [
      "--transform=s,runner,../escape,",
      "-czf",
      traversal,
      "-C",
      input,
      "runner",
    ]);
    await assert.rejects(extractArchiveSafely(traversal, output), /Unsafe component path/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
