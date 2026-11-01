import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { synchronizeMacAsarIntegrityMetadata } from "../scripts/macos-asar-integrity-metadata.mjs";

const require = createRequire(import.meta.url);
const plist = require("plist");
const pickle = require("chromium-pickle-js");
const { createPackage } = require("@electron/asar");
const { computeData } = require("app-builder-lib/out/asar/integrity.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "uwork-asar-metadata-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = join(root, "Owned 中文.app", "Contents");
  const resources = join(contents, "Resources");
  const input = join(root, "input");
  await mkdir(resources, { recursive: true });
  await mkdir(input);
  await writeFile(join(input, "中文😀.txt"), "owned header fixture");
  const appAsarPath = join(resources, "app.asar");
  await createPackage(input, appAsarPath);
  const metadata = await computeData({
    resourcesPath: resources,
    resourcesRelativePath: "Resources",
    resourcesDestinationPath: resources,
    extraResourceMatchers: [],
  });
  const info = join(contents, "Info.plist");
  const original = {
    CFBundleIdentifier: "dev.zcode.owned.asar-helper",
    OwnedUnrelated: { label: "保留😀", values: [1, true, "<&>"] },
    ElectronAsarIntegrity: {
      ...metadata,
      "Resources/retained.asar": { algorithm: "SHA256", hash: "f".repeat(64) },
    },
  };
  await writeFile(info, plist.build(original));
  return { appAsarPath, info, original, metadata, input, resources };
}

const invoke = (f) =>
  synchronizeMacAsarIntegrityMetadata({
    electronPlatformName: "darwin",
    appAsarPath: f.appAsarPath,
  });

test("updates stale metadata using the final archive and preserves unrelated plist values/entries", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.input, "new.txt"), "real later repack");
  await createPackage(f.input, f.appAsarPath);
  const expected = await computeData({
    resourcesPath: f.resources,
    resourcesRelativePath: "Resources",
    resourcesDestinationPath: f.resources,
    extraResourceMatchers: [],
  });
  assert.notDeepEqual(expected["Resources/app.asar"], f.metadata["Resources/app.asar"]);
  const archive = await readFile(f.appAsarPath);
  await invoke(f);
  const current = plist.parse(await readFile(f.info, "utf8"));
  assert.deepEqual(current, {
    ...f.original,
    ElectronAsarIntegrity: { ...f.original.ElectronAsarIntegrity, ...expected },
  });
  assert.deepEqual(await readFile(f.appAsarPath), archive);
});

test("hashes original UTF8 JSON header bytes, including whitespace and Unicode, not normalized JSON/padding", async (t) => {
  const f = await fixture(t);
  const header = ' {\n "files": {"中文 😀.txt": {"size":0,"offset":"0"}}\n }\n';
  const body = pickle.createEmpty();
  body.writeString(header);
  const size = pickle.createEmpty();
  size.writeUInt32(body.toBuffer().length);
  await writeFile(f.appAsarPath, Buffer.concat([size.toBuffer(), body.toBuffer()]));
  await invoke(f);
  const actual = plist.parse(await readFile(f.info, "utf8"));
  const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
  assert.equal(actual.ElectronAsarIntegrity["Resources/app.asar"].hash, hash(header));
  assert.notEqual(hash(header), hash(JSON.stringify(JSON.parse(header))));
});

test("already correct metadata preserves exact plist bytes and modification time", async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(f.info);
  const before = await stat(f.info, { bigint: true });
  await invoke(f);
  assert.deepEqual(await readFile(f.info), bytes);
  assert.equal((await stat(f.info, { bigint: true })).mtimeNs, before.mtimeNs);
});

test("non-Mac targets return without reading or writing even an absent archive", async () => {
  for (const electronPlatformName of ["win32", "linux"]) {
    await synchronizeMacAsarIntegrityMetadata({
      electronPlatformName,
      appAsarPath: "/nonexistent/owned.asar",
    });
  }
});

test("missing archive fails and leaves the plist untouched", async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(f.info);
  await rm(f.appAsarPath);
  await assert.rejects(invoke(f), { code: "ENOENT" });
  assert.deepEqual(await readFile(f.info), bytes);
});

test("missing or malformed Info.plist fails instead of manufacturing a new bundle declaration", async (t) => {
  const f = await fixture(t);
  await rm(f.info);
  await assert.rejects(invoke(f), { code: "ENOENT" });
  await writeFile(f.info, "not an XML plist");
  await assert.rejects(invoke(f));
  assert.equal(await readFile(f.info, "utf8"), "not an XML plist");
});

test("absent integrity declaration/entry fails rather than silently repairing an unrelated bundle", async (t) => {
  const f = await fixture(t);
  for (const value of [{ CFBundleIdentifier: "owned" }, { ElectronAsarIntegrity: {} }]) {
    await writeFile(f.info, plist.build(value));
    const bytes = await readFile(f.info);
    await assert.rejects(invoke(f), /integrity/i);
    assert.deepEqual(await readFile(f.info), bytes);
  }
});

test("truncated or invalid JSON ASAR header fails without altering Info.plist", async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(f.info);
  await writeFile(f.appAsarPath, Buffer.from([4, 0, 0]));
  await assert.rejects(invoke(f));
  const body = pickle.createEmpty();
  body.writeString("not JSON");
  const size = pickle.createEmpty();
  size.writeUInt32(body.toBuffer().length);
  await writeFile(f.appAsarPath, Buffer.concat([size.toBuffer(), body.toBuffer()]));
  await assert.rejects(invoke(f));
  assert.deepEqual(await readFile(f.info), bytes);
});
