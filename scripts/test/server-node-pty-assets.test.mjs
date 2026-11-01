import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { resolveNodePtyPrebuildAssets } from "../node-pty-prebuild-assets.mjs";

const repo = resolve(import.meta.dirname, "../..");
const keys = ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"];
const old = Buffer.from("OLD_BETA_NATIVE_MUST_NOT_BE_REUSED");
const json = (p, v) => writeFile(p, JSON.stringify(v) + "\n");
function binary(key, tag = "native") {
  const [os, arch] = key.split("-");
  const b = Buffer.alloc(64);
  if (os === "linux") {
    b.set([127, 69, 76, 70, 2, 1, 1]);
    b.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  } else {
    b.writeUInt32LE(0xfeedfacf);
    b.writeUInt32LE(arch === "arm64" ? 0x100000c : 0x1000007, 4);
  }
  return Buffer.concat([b, Buffer.from(key + tag)]);
}
async function fixture(t, { nested = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "uwork-server-nodepty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules/node-pty/lib"), { recursive: true });
  await mkdir(join(root, "packages/server"), { recursive: true });
  await mkdir(join(root, "packages/shared/src"), { recursive: true });
  await json(join(root, "package.json"), { version: "3.16.0", type: "module" });
  await json(join(root, "packages/server/package.json"), { name: "@zcode/server", private: true });
  await writeFile(
    join(root, "packages/shared/src/zcode-agent-runtime.ts"),
    'export const r = { version: "test-runtime" };\n',
  );
  await json(join(root, "node_modules/node-pty/package.json"), {
    name: "node-pty",
    version: "1.1.0",
    main: "lib/index.js",
  });
  await writeFile(join(root, "node_modules/node-pty/lib/index.js"), "module.exports = {};\n");
  for (const key of keys) {
    const [os, arch] = key.split("-");
    const n = join(root, "node_modules/@lydell/node-pty-" + key);
    const source = nested ? join(n, "prebuilds", key) : n;
    await mkdir(source, { recursive: true });
    await json(join(n, "package.json"), {
      name: "@lydell/node-pty-" + key,
      version: "1.1.0",
      os: [os],
      cpu: [arch],
    });
    await writeFile(join(source, "pty.node"), binary(key));
    if (os === "darwin")
      await writeFile(join(source, "spawn-helper"), binary(key, "helper"), { mode: 0o644 });
  }
  return {
    root,
    js: join(root, "node_modules/node-pty"),
    native: (key) => join(root, "node_modules/@lydell/node-pty-" + key),
    source: (key) =>
      join(root, "node_modules/@lydell/node-pty-" + key, ...(nested ? ["prebuilds", key] : [])),
  };
}
async function originalModule(f, relative, extra = "") {
  const outfile = join(f.root, relative.replace(/\.ts$/, ".mjs"));
  await mkdir(dirname(outfile), { recursive: true });
  const source = await readFile(join(repo, relative), "utf8");
  await build({
    stdin: {
      contents: source + extra,
      resolveDir: dirname(join(repo, relative)),
      sourcefile: join(repo, relative),
      loader: relative.endsWith(".ts") ? "ts" : "js",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import {createRequire as _fixtureRequire} from "node:module";const require=_fixtureRequire(import.meta.url);',
    },
  });
  return import(pathToFileURL(outfile).href);
}
async function agentTarget(f) {
  const output = join(f.root, "agent-stage");
  for (const key of keys) {
    const dir = join(output, "node_modules/node-pty/prebuilds", key);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pty.node"), old);
  }
  await json(join(output, "node_modules/node-pty/package.json"), {
    name: "node-pty",
    version: "1.1.0",
  });
  return output;
}
test("Server pins the same JS and all four native packages exactly1.1", async () => {
  const p = JSON.parse(await readFile(join(repo, "packages/server/package.json")));
  for (const name of ["node-pty", ...keys.map((key) => "@lydell/node-pty-" + key)])
    assert.equal(p.dependencies[name], "1.1.0", name);
});
test("original Agent asset producer replaces stale beta targets from matching flat1.1 for all platforms", async (t) => {
  const f = await fixture(t);
  const output = await agentTarget(f);
  const m = await originalModule(f, "scripts/zcode-distribution/assets.mjs");
  await m.patchNodePtyPrebuilds(output);
  for (const key of keys) {
    assert.deepEqual(
      await readFile(join(output, "node_modules/node-pty/prebuilds", key, "pty.node")),
      binary(key),
    );
    if (key.startsWith("darwin"))
      assert.deepEqual(
        await readFile(join(output, "node_modules/node-pty/prebuilds", key, "spawn-helper")),
        binary(key, "helper"),
      );
  }
});
test("original remote asset producer replaces existing Beta cache before component versioning", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "packages/desktop/mock-cdn/releases/3.16.0/node-pty");
  for (const key of keys) {
    await mkdir(join(target, key), { recursive: true });
    await writeFile(join(target, key, "pty.node"), old);
    if (key.startsWith("darwin")) await writeFile(join(target, key, "spawn-helper"), old);
  }
  // 只给原函数增加测试可见性；未替换原函数行为，也不执行远端main。
  const m = await originalModule(
    f,
    "scripts/prepare-prebuilds.mjs",
    "\nexport { copyNodePtyPrebuilds };\n",
  );
  m.copyNodePtyPrebuilds();
  for (const key of keys)
    assert.deepEqual(await readFile(join(target, key, "pty.node")), binary(key));
});
test("original Server stage accepts official flat Linux1.1", async (t) => {
  const f = await fixture(t);
  const m = await originalModule(f, "packages/zcode-server-cli/src/packaging/stage.ts");
  const dist = join(f.root, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "server-cli.js"), 'require("node-pty");\n');
  await writeFile(join(dist, "server-core.js"), "// stage fixture only\n");
  await writeFile(join(f.root, "agent.cjs"), "// agent fixture only\n");
  await writeFile(join(f.root, "node"), "fixture node bytes, never executed\n");
  const result = await m.stageRelease({
    target: "linux-arm64",
    appVersion: "3.16.0",
    distDir: dist,
    agentBundlePath: join(f.root, "agent.cjs"),
    nodeBinaryPath: join(f.root, "node"),
    notices: { thirdParty: "notice\n", node: "node notice\n", nodeSource: "{}\n" },
    workspaceNodeModulesDir: join(f.root, "node_modules"),
    workspacePackageDirs: new Map(),
    outputDir: join(f.root, "output"),
    archive: false,
  });
  assert.deepEqual(
    await readFile(
      join(result.releaseDir, "runtime/node_modules/node-pty/prebuilds/linux-arm64/pty.node"),
    ),
    binary("linux-arm64"),
  );
});

for (const key of keys) {
  test(`shared canonical plan validates flat original1.1 ${key} without writing input`, async (t) => {
    const f = await fixture(t);
    const plan = resolveNodePtyPrebuildAssets({
      jsPackageRoot: f.js,
      nativePackageRoot: f.native(key),
      platformKey: key,
    });
    assert.equal(plan.version, "1.1.0");
    assert.equal(plan.nativePath, join(f.native(key), "pty.node"));
    assert.ok(Object.isFrozen(plan));
    assert.deepEqual(await readFile(plan.nativePath), binary(key));
    if (key.startsWith("darwin"))
      assert.equal(plan.spawnHelperPath, join(f.native(key), "spawn-helper"));
  });
}

const invalid = [
  [
    "native beta",
    async (f) =>
      json(join(f.native("darwin-arm64"), "package.json"), {
        name: "@lydell/node-pty-darwin-arm64",
        version: "1.2.0-beta.10",
        os: ["darwin"],
        cpu: ["arm64"],
      }),
  ],
  [
    "wrong native identity",
    async (f) =>
      json(join(f.native("darwin-arm64"), "package.json"), {
        name: "foreign",
        version: "1.1.0",
        os: ["darwin"],
        cpu: ["arm64"],
      }),
  ],
  [
    "wrong native OS",
    async (f) =>
      json(join(f.native("darwin-arm64"), "package.json"), {
        name: "@lydell/node-pty-darwin-arm64",
        version: "1.1.0",
        os: ["linux"],
        cpu: ["arm64"],
      }),
  ],
  [
    "wrong native CPU",
    async (f) =>
      json(join(f.native("darwin-arm64"), "package.json"), {
        name: "@lydell/node-pty-darwin-arm64",
        version: "1.1.0",
        os: ["darwin"],
        cpu: ["x64"],
      }),
  ],
  ["missing same-layout helper", async (f) => rm(join(f.native("darwin-arm64"), "spawn-helper"))],
  [
    "helper wrong architecture",
    async (f) => writeFile(join(f.native("darwin-arm64"), "spawn-helper"), binary("darwin-x64")),
  ],
  [
    "native wrong architecture",
    async (f) => writeFile(join(f.native("darwin-arm64"), "pty.node"), binary("darwin-x64")),
  ],
  [
    "native wrong magic",
    async (f) => writeFile(join(f.native("darwin-arm64"), "pty.node"), binary("linux-arm64")),
  ],
  [
    "dual native layouts",
    async (f) => {
      const dir = join(f.native("darwin-arm64"), "prebuilds/darwin-arm64");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "pty.node"), binary("darwin-arm64"));
    },
  ],
];
for (const [label, mutate] of invalid) {
  test(`shared Darwin asset plan refuses ${label}`, async (t) => {
    const f = await fixture(t);
    await mutate(f);
    assert.throws(() =>
      resolveNodePtyPrebuildAssets({
        jsPackageRoot: f.js,
        nativePackageRoot: f.native("darwin-arm64"),
        platformKey: "darwin-arm64",
      }),
    );
  });
}

test("shared plan rejects unsupported target before reading arbitrary roots", () => {
  assert.throws(
    () =>
      resolveNodePtyPrebuildAssets({
        jsPackageRoot: "/missing",
        nativePackageRoot: "/missing",
        platformKey: "win32-x64",
      }),
    /不支持/,
  );
});

test("Agent validates all four sources before modifying even its first staged platform", async (t) => {
  const f = await fixture(t, { nested: true });
  const output = await agentTarget(f);
  await json(join(f.native("darwin-x64"), "package.json"), {
    name: "@lydell/node-pty-darwin-x64",
    version: "1.2.0-beta.10",
    os: ["darwin"],
    cpu: ["x64"],
  });
  const m = await originalModule(f, "scripts/zcode-distribution/assets.mjs");
  await assert.rejects(m.patchNodePtyPrebuilds(output), /版本或平台不一致/);
  for (const key of keys)
    assert.deepEqual(
      await readFile(join(output, "node_modules/node-pty/prebuilds", key, "pty.node")),
      old,
    );
});

test("remote producer validates all sources before deleting its existing first cache", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "packages/desktop/mock-cdn/releases/3.16.0/node-pty");
  for (const key of keys) {
    await mkdir(join(target, key), { recursive: true });
    await writeFile(join(target, key, "pty.node"), old);
  }
  await rm(join(f.native("darwin-x64"), "spawn-helper"));
  const m = await originalModule(
    f,
    "scripts/prepare-prebuilds.mjs",
    "\nexport { copyNodePtyPrebuilds };\n",
  );
  assert.throws(() => m.copyNodePtyPrebuilds(), /spawn-helper/);
  for (const key of keys) assert.deepEqual(await readFile(join(target, key, "pty.node")), old);
});

test("remote canonical content replaces old cache and produces1.1 identity from the new actual bytes", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "packages/desktop/mock-cdn/releases/3.16.0/node-pty");
  for (const key of keys) {
    await mkdir(join(target, key), { recursive: true });
    await writeFile(join(target, key, "pty.node"), old);
    await writeFile(join(target, key, "old-beta-extra.js"), old);
  }
  const m = await originalModule(
    f,
    "scripts/prepare-prebuilds.mjs",
    "\nexport { copyNodePtyPrebuilds };\n",
  );
  const before = m.computeComponentSourceSha256(join(target, "linux-arm64"));
  m.copyNodePtyPrebuilds();
  for (const key of keys) {
    const component = m.buildRemoteComponentDefinitions(key).find((row) => row.id === "node-pty");
    assert.equal(component.semanticPrefix, "1.1.0");
    await assert.rejects(access(join(target, key, "old-beta-extra.js")), { code: "ENOENT" });
    const artifact = m.prepareRemoteComponentArtifact({
      mockCdnDir: join(f.root, "private-artifacts"),
      platformKey: key,
      component,
    });
    assert.equal(artifact.sourceSha256, m.computeComponentSourceSha256(component.sourcePath));
    assert.match(artifact.version, /^v1\.1\.0\+[a-f0-9]{12}$/);
    if (key === "linux-arm64") assert.notEqual(artifact.sourceSha256, before);
    if (key.startsWith("darwin"))
      assert.equal((await stat(join(target, key, "spawn-helper"))).mode & 0o777, 0o755);
  }
});

async function stageFixture(f, target) {
  const m = await originalModule(f, "packages/zcode-server-cli/src/packaging/stage.ts");
  const dist = join(f.root, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "server-cli.js"), 'require("node-pty");\n');
  await writeFile(join(dist, "server-core.js"), "// stage fixture only\n");
  await writeFile(join(f.root, "agent.cjs"), "// agent fixture only\n");
  await writeFile(join(f.root, "node"), "fixture node bytes, never executed\n");
  return m.stageRelease({
    target,
    appVersion: "3.16.0",
    distDir: dist,
    agentBundlePath: join(f.root, "agent.cjs"),
    nodeBinaryPath: join(f.root, "node"),
    notices: { thirdParty: "notice\n", node: "node notice\n", nodeSource: "{}\n" },
    workspaceNodeModulesDir: join(f.root, "node_modules"),
    workspacePackageDirs: new Map(),
    outputDir: join(f.root, "output"),
    archive: false,
  });
}

test("Server stage replaces existing Beta native instead of accepting file existence", async (t) => {
  const f = await fixture(t);
  const prior = join(f.js, "prebuilds/linux-arm64/pty.node");
  await mkdir(dirname(prior), { recursive: true });
  await writeFile(prior, old);
  const result = await stageFixture(f, "linux-arm64");
  assert.deepEqual(
    await readFile(
      join(result.releaseDir, "runtime/node_modules/node-pty/prebuilds/linux-arm64/pty.node"),
    ),
    binary("linux-arm64"),
  );
  assert.deepEqual(await readFile(prior), old, "Original input must not be rewritten");
});
for (const key of ["darwin-arm64", "darwin-x64"]) {
  test(`Server stage copies same-source flat ${key} helper and fixes destination execute mode`, async (t) => {
    const f = await fixture(t);
    const result = await stageFixture(f, key);
    const helper = join(
      result.releaseDir,
      "runtime/node_modules/node-pty/prebuilds",
      key,
      "spawn-helper",
    );
    assert.deepEqual(await readFile(helper), binary(key, "helper"));
    assert.equal((await stat(helper)).mode & 0o777, 0o755);
    assert.equal((await stat(join(f.native(key), "spawn-helper"))).mode & 0o777, 0o644);
  });
}
test("Server stage refuses mismatching native version and never emits a successful release manifest", async (t) => {
  const f = await fixture(t);
  await json(join(f.native("linux-arm64"), "package.json"), {
    name: "@lydell/node-pty-linux-arm64",
    version: "1.2.0-beta.10",
    os: ["linux"],
    cpu: ["arm64"],
  });
  await assert.rejects(stageFixture(f, "linux-arm64"), /版本或平台不一致/);
  await assert.rejects(access(join(f.root, "output/zcode-server-linux-arm64/manifest.json")), {
    code: "ENOENT",
  });
});
