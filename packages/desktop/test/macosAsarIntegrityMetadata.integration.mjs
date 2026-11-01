import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { collectRuntimeModuleClosureEntries } from "../scripts/runtime-dependency-closure.mjs";
import { DESKTOP_ASAR_RUNTIME_MODULES } from "../scripts/desktop-asar-runtime-modules.mjs";

const require = createRequire(import.meta.url);
const {
  createPackage,
  createPackageWithOptions,
  extractFile,
  listPackage,
} = require("@electron/asar");
const { computeData } = require("app-builder-lib/out/asar/integrity.js");
const { readAsarHeader } = require("app-builder-lib/out/asar/asar.js");
const plist = require("plist");
const client = resolve(import.meta.dirname, "../../.."),
  desktop = resolve(import.meta.dirname, "..");
const environment = {
  ZCODE_TARGET_OS: "darwin",
  ZCODE_TARGET_ARCH: "arm64",
  ZCODE_MAC_ADHOC_SIGN: "0",
  ZCODE_ENABLE_MAC_SIGN: "0",
};
const originalEnvironment = Object.fromEntries(
  Object.keys(environment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, environment);
after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const { default: configuration } = await import("../electron-builder.config.js");

async function headerHash(file) {
  // Match installed builder and Electron41: hash original ReadString UTF8 bytes, not JSON normalization or Pickle padding.
  const { header } = await readAsarHeader(file);
  return createHash("sha256").update(header, "utf8").digest("hex");
}
async function fixture(t, rewrite) {
  const root = await mkdtemp(join(tmpdir(), "uwork-macos-asar-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = "Owned Metadata 夹具",
    app = join(root, "out", name + ".app"),
    resources = join(app, "Contents", "Resources"),
    input = join(root, "input"),
    retained = join(root, "retained");
  await Promise.all([mkdir(resources, { recursive: true }), mkdir(input), mkdir(retained)]);
  await writeFile(
    join(input, "package.json"),
    JSON.stringify({ name: "owned-metadata-fixture", private: true }),
  );
  await writeFile(
    join(input, "entry.js"),
    'globalThis.ownedMetadata = "中文 fixture";\n' +
      (rewrite ? "//# sourceMappingURL=entry.js.map\n" : ""),
  );
  if (rewrite)
    await writeFile(join(input, "entry.js.map"), '{"version":3,"sources":[],"mappings":""}');
  // Unrelated runtime-closure checks keep real manifest inputs; no Node/native code is loaded and no full runtime acceptance is claimed.
  const closure = collectRuntimeModuleClosureEntries(DESKTOP_ASAR_RUNTIME_MODULES, [
    desktop,
    client,
  ]);
  for (const entry of closure) {
    if (!entry.sourceModulePath) continue;
    const destination = join(input, "node_modules", entry.moduleName);
    await mkdir(destination, { recursive: true });
    await copyFile(entry.packageJsonPath, join(destination, "package.json"));
  }
  const ptyRoot = dirname(require.resolve("node-pty/package.json")),
    prebuildDir = join(input, "node_modules", "node-pty", "prebuilds", "darwin-arm64");
  await mkdir(prebuildDir, { recursive: true });
  await copyFile(
    join(ptyRoot, "prebuilds", "darwin-arm64", "pty.node"),
    join(prebuildDir, "pty.node"),
  );
  const archive = join(resources, "app.asar");
  await createPackageWithOptions(input, archive, {
    unpack: "*.{node,dll,dylib,exe}",
    unpackDir: "node_modules/node-pty/prebuilds/darwin-arm64",
  });
  await writeFile(join(retained, "retained.txt"), "Other ASAR entry must remain intact.\n");
  await createPackage(retained, join(resources, "retained.asar"));
  const initial = await computeData({
    resourcesPath: resources,
    resourcesRelativePath: "Resources",
    resourcesDestinationPath: resources,
    extraResourceMatchers: [],
  });
  const info = join(app, "Contents", "Info.plist"),
    originalInfo = {
      CFBundleIdentifier: "dev.zcode.owned.metadata-fixture",
      CFBundleName: name,
      CFBundleShortVersionString: "0.0.0",
      OwnedUnrelated: { text: "必须保持", values: [1, true, "😀"] },
      ElectronAsarIntegrity: initial,
    };
  await writeFile(info, plist.build(originalInfo), "utf8");
  const originalInfoBytes = await readFile(info);
  assert.equal(initial["Resources/app.asar"].hash, await headerHash(archive));
  const context = {
    appOutDir: join(root, "out"),
    electronPlatformName: "darwin",
    arch: 3,
    packager: { appInfo: { productFilename: name } },
  };
  return { archive, info, initial, context, originalInfo, originalInfoBytes };
}

test("actual Mac afterPack final repack synchronizes Info.plist header integrity before signing", async (t) => {
  const f = await fixture(t, true),
    before = await headerHash(f.archive);
  await configuration.afterPack(f.context);
  const finalHash = await headerHash(f.archive),
    current = plist.parse(await readFile(f.info, "utf8"));
  assert.notEqual(finalHash, before, "The real sourcemap hook must actually rewrite the archive");
  assert.doesNotMatch(extractFile(f.archive, "entry.js").toString("utf8"), /sourceMappingURL/);
  assert.ok(!listPackage(f.archive).some((path) => path.endsWith(".map")));
  assert.equal(current.ElectronAsarIntegrity["Resources/app.asar"].algorithm, "SHA256");
  assert.equal(
    current.ElectronAsarIntegrity["Resources/app.asar"].hash,
    finalHash,
    "Final pre-sign metadata must describe the final repacked header",
  );
  assert.deepEqual(
    current.ElectronAsarIntegrity["Resources/retained.asar"],
    f.initial["Resources/retained.asar"],
  );
  delete current.ElectronAsarIntegrity;
  const { ElectronAsarIntegrity, ...unrelated } = f.originalInfo;
  assert.ok(ElectronAsarIntegrity);
  assert.deepEqual(current, unrelated);
});

test("actual Mac afterPack without mutation retains correct metadata and all unrelated plist bytes", async (t) => {
  const f = await fixture(t, false),
    before = await headerHash(f.archive);
  await configuration.afterPack(f.context);
  const current = plist.parse(await readFile(f.info, "utf8"));
  assert.equal(await headerHash(f.archive), before);
  assert.equal(current.ElectronAsarIntegrity["Resources/app.asar"].hash, before);
  assert.deepEqual(await readFile(f.info), f.originalInfoBytes);
  assert.deepEqual(current, f.originalInfo);
});
