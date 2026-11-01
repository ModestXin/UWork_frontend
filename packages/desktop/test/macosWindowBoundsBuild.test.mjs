import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const desktop = resolve(import.meta.dirname, "..");

async function fixture(t, target, { fail = false, missingCompiler = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "window-bounds-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of [
    "scripts",
    "native/macos-window-bounds",
    "resources/macos-window-bounds",
    "bin",
  ])
    await mkdir(join(root, dir), { recursive: true });
  for (const file of ["build-macos-window-bounds.mjs", "target-platform.mjs"])
    await copyFile(join(desktop, "scripts", file), join(root, "scripts", file));
  await writeFile(
    join(root, "native/macos-window-bounds/main.swift"),
    "// owned compiler fixture\n",
  );
  const output = join(root, `resources/macos-window-bounds/zcode-window-bounds-${target}`);
  const hostOutput = join(root, "resources/macos-window-bounds/zcode-window-bounds");
  await writeFile(output, "stale-other-architecture");
  await writeFile(hostOutput, "existing-host-helper");
  await writeFile(
    join(root, "bin/xcrun"),
    `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='--find')process.exit(${JSON.stringify(missingCompiler)}?1:0);
const arch=args[args.indexOf('-target')+1];
fs.appendFileSync(${JSON.stringify(join(root, "compiler-calls"))},arch+'\\n');
if(${JSON.stringify(fail)})process.exit(3);
fs.writeFileSync(args[args.indexOf('-o')+1],arch);
`,
    { mode: 0o755 },
  );
  await writeFile(join(root, "bin/lipo"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  // The real script and target parser execute in a subprocess; only the compiler is controlled.
  const result = await exec(
    process.execPath,
    [join(root, "scripts/build-macos-window-bounds.mjs")],
    {
      env: {
        ...process.env,
        PATH: join(root, "bin") + ":" + process.env.PATH,
        ZCODE_TARGET_OS: "mac",
        ZCODE_TARGET_ARCH: target,
      },
    },
  );
  return { root, output, hostOutput, result, target };
}

for (const [target, triple] of [
  ["arm64", "arm64-apple-macos11"],
  ["x64", "x86_64-apple-macos11"],
])
  test(
    `window bounds build produces only the requested ${target} executable`,
    { skip: process.platform !== "darwin" },
    async (t) => {
      const f = await fixture(t, target);
      assert.equal(await readFile(f.output, "utf8"), triple);
      assert.equal(await readFile(join(f.root, "compiler-calls"), "utf8"), triple + "\n");
      assert.equal(
        await readFile(f.hostOutput, "utf8"),
        target === process.arch ? triple : "existing-host-helper",
      );
      assert.deepEqual(
        (await readdir(join(f.root, "resources/macos-window-bounds"))).sort(),
        ["zcode-window-bounds", `zcode-window-bounds-${target}`].sort(),
      );
    },
  );

test(
  "failed compilation cannot leave another architecture's helper in the package",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const f = await fixture(t, "arm64", { fail: true });
    assert.match(f.result.stderr, /构建失败/);
    await assert.rejects(readFile(f.output), { code: "ENOENT" });
    assert.deepEqual(
      await readdir(join(f.root, "resources/macos-window-bounds")),
      process.arch === "arm64" ? [] : ["zcode-window-bounds"],
    );
  },
);

test(
  "missing Swift cannot retain a stale helper as a successful build",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const f = await fixture(t, "arm64", { missingCompiler: true });
    assert.match(f.result.stderr, /未找到 swiftc/);
    await assert.rejects(readFile(f.output), { code: "ENOENT" });
    assert.deepEqual(
      await readdir(join(f.root, "resources/macos-window-bounds")),
      process.arch === "arm64" ? [] : ["zcode-window-bounds"],
    );
    await assert.rejects(readFile(join(f.root, "compiler-calls")), { code: "ENOENT" });
  },
);
