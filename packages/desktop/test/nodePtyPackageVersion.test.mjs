import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { restoreTargetNodePtyPrebuild } from "../scripts/node-pty-package-assets.mjs";

const existing = Buffer.from("EXISTING_TARGET_MUST_SURVIVE_REJECTION");
const json = (path, value) => writeFileSync(path, JSON.stringify(value) + "\n");

function elf(arch) {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(64, 52);
  return Buffer.concat([header, Buffer.from(`OWNED_OFFLINE_NATIVE_${arch}`)]);
}

function fixture(t, arch = "arm64") {
  const root = mkdtempSync(join(tmpdir(), "uwork-nodepty-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktopPackageRoot = join(root, "desktop");
  const jsRoot = join(desktopPackageRoot, "node_modules", "node-pty");
  const key = `linux-${arch}`;
  const sourceName = `@lydell/node-pty-${key}`;
  const nativeRoot = join(desktopPackageRoot, "node_modules", sourceName);
  const target = join(jsRoot, "prebuilds", key, "pty.node");
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(nativeRoot, { recursive: true });
  mkdirSync(join(jsRoot, "lib"));
  const js = { name: "node-pty", version: "1.1.0", main: "./lib/index.js" };
  const native = { name: sourceName, version: "1.1.0", os: ["linux"], cpu: [arch] };
  // 官方1.1平台包只有metadata/README/平铺pty.node，没有JS入口或prebuilds目录。
  json(join(jsRoot, "package.json"), js);
  writeFileSync(join(jsRoot, "lib/index.js"), "module.exports = {};\n");
  json(join(nativeRoot, "package.json"), native);
  const binary = elf(arch);
  writeFileSync(join(nativeRoot, "pty.node"), binary);
  writeFileSync(target, existing);
  const restore = () =>
    restoreTargetNodePtyPrebuild({
      desktopPackageRoot,
      targetPlatform: { os: "linux", arch, key },
    });
  return { desktopPackageRoot, jsRoot, nativeRoot, target, js, native, binary, restore };
}

for (const arch of ["arm64", "x64"]) {
  test(`explicit Desktop filesystem resolves and copies matching official 1.1 ${arch} native`, (t) => {
    const value = fixture(t, arch);
    value.restore();
    const actual = readFileSync(value.target);
    assert.equal(actual.length, value.binary.length);
    assert.deepEqual(actual, value.binary);
    assert.equal(JSON.parse(readFileSync(join(value.jsRoot, "package.json"))).version, "1.1.0");
    assert.equal(JSON.parse(readFileSync(join(value.nativeRoot, "package.json"))).version, "1.1.0");
  });
}

const badMetadata = [
  ["native beta mismatches JS1.1", "native", { version: "1.2.0-beta.10" }],
  ["JS beta mismatches native1.1", "js", { version: "1.2.0-beta.10" }],
  ["wrong native package name", "native", { name: "@foreign/node-pty-linux-arm64" }],
  ["wrong JS package name", "js", { name: "foreign-pty" }],
  ["native version missing", "native", { version: undefined }],
  ["JS version missing", "js", { version: undefined }],
  ["native version empty", "native", { version: "" }],
  ["JS version empty", "js", { version: "" }],
  ["wrong native os", "native", { os: ["darwin"] }],
  ["wrong native cpu", "native", { cpu: ["x64"] }],
  ["native os missing", "native", { os: undefined }],
  ["native cpu missing", "native", { cpu: undefined }],
];

for (const [label, owner, change] of badMetadata) {
  test(`${label} rejects before replacing the existing target`, (t) => {
    const value = fixture(t);
    const path = owner === "js" ? value.jsRoot : value.nativeRoot;
    json(join(path, "package.json"), { ...value[owner], ...change });
    assert.throws(value.restore, Error);
    assert.deepEqual(readFileSync(value.target), existing);
  });
}

const badElf = [
  [
    "wrong ELF magic",
    (bytes) => {
      bytes[0] = 0;
      return bytes;
    },
  ],
  [
    "32-bit ELF",
    (bytes) => {
      bytes[4] = 1;
      return bytes;
    },
  ],
  [
    "big-endian ELF",
    (bytes) => {
      bytes[5] = 2;
      return bytes;
    },
  ],
  [
    "wrong ARM64 machine",
    (bytes) => {
      bytes.writeUInt16LE(62, 18);
      return bytes;
    },
  ],
  ["truncated ELF header", (bytes) => bytes.subarray(0, 10)],
];
for (const [label, mutate] of badElf) {
  test(`${label} rejects before replacing the existing target`, (t) => {
    const value = fixture(t);
    writeFileSync(join(value.nativeRoot, "pty.node"), mutate(Buffer.from(value.binary)));
    assert.throws(value.restore, Error);
    assert.deepEqual(readFileSync(value.target), existing);
  });
}

test("x64 target rejects an ARM64 ELF before replacing its existing target", (t) => {
  const value = fixture(t, "x64");
  writeFileSync(join(value.nativeRoot, "pty.node"), elf("arm64"));
  assert.throws(value.restore, Error);
  assert.deepEqual(readFileSync(value.target), existing);
});

test("ambiguous flat and prebuild natives reject before replacing the existing target", (t) => {
  const value = fixture(t);
  const duplicate = join(value.nativeRoot, "prebuilds/linux-arm64/pty.node");
  mkdirSync(dirname(duplicate), { recursive: true });
  writeFileSync(duplicate, value.binary);
  assert.throws(value.restore, Error);
  assert.deepEqual(readFileSync(value.target), existing);
});

test("Darwin skip never resolves missing packages or changes existing native bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "uwork-nodepty-version-darwin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, existing);
  restoreTargetNodePtyPrebuild({
    desktopPackageRoot: root,
    targetPlatform: { os: "darwin", arch: "arm64", key: "darwin-arm64" },
  });
  assert.deepEqual(readFileSync(target), existing);
});

test("Desktop pins the complete 1.1 group exactly", () => {
  const desktop = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json")));
  for (const name of ["node-pty", "@lydell/node-pty-linux-arm64", "@lydell/node-pty-linux-x64"])
    assert.equal(desktop.dependencies[name], "1.1.0", `Desktop exact matching pin: ${name}`);
});

test("Server JS and four platform dependency pins match the original1.1 ABI", () => {
  const server = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../server/package.json")),
  );
  assert.equal(server.dependencies["node-pty"], "1.1.0");
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
    assert.equal(server.dependencies[`@lydell/node-pty-${platform}`], "1.1.0");
});
