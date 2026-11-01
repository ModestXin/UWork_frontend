import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addMarketplace,
  ensureDefaultPluginMarketplaces,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  uninstallMarketplacePlugin,
} from "../src/plugins/marketplace.js";
import { writeCdnOfficialMarketplacePartitionSync } from "../src/plugins/official-marketplace.js";

async function fixture(run: (root: string, storageRoot: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uwork-cache-reference-")));
  const storageRoot = join(root, "storage");
  await mkdir(storageRoot);
  try {
    await run(root, storageRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function json(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
async function install(root: string, storageRoot: string, marketplace: string, version: string) {
  const source = join(root, "inputs", marketplace, "owned-note");
  await json(join(source, ".zcode-plugin", "plugin.json"), { name: "owned-note", version });
  await writeFile(join(source, "payload.txt"), version);
  const manifest = {
    name: marketplace,
    plugins: [{ name: "owned-note", source: { source: "directory", path: source } }],
  };
  if (marketplace === "zcode-plugins-official") {
    ensureDefaultPluginMarketplaces(storageRoot);
    writeCdnOfficialMarketplacePartitionSync({ storageRoot, manifest });
  } else {
    const file = join(root, "inputs", marketplace, "marketplace.json");
    await json(file, manifest);
    await addMarketplace({ source: { source: "file", path: file }, storageRoot });
  }
  const result = await installMarketplacePlugin({ storageRoot, marketplace, name: "owned-note" });
  const record = result.installed.find((x) => x.id === `owned-note@${marketplace}`);
  assert.ok(record);
  return record;
}

test("a valid legacy installation through another path alias retains the referenced owner", async () =>
  fixture(async (root, storageRoot) => {
    const first = await install(root, storageRoot, "first-market", "1.0.0");
    const second = await install(root, storageRoot, "first-market", "2.0.0");
    const other = await install(root, storageRoot, "other-market", "1.0.0");
    const alias = join(storageRoot, "legacy-cache-alias");
    await symlink(
      join(storageRoot, "cache", "first-market", "owned-note"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    // Both packages were installed normally; the supported legacy record uses its historical alias.
    await json(join(storageRoot, "installed_plugins.json"), {
      version: 1,
      plugins: [second, { ...other, installPath: join(alias, "1.0.0") }],
    });
    await uninstallMarketplacePlugin({ storageRoot, pluginId: second.id, removeCache: true });
    assert.deepEqual(
      listInstalledPluginRecords(storageRoot).map((x) => x.id),
      [other.id],
    );
    assert.equal(await readFile(join(first.installPath, "payload.txt"), "utf8"), "1.0.0");
    assert.equal(await readFile(join(second.installPath, "payload.txt"), "utf8"), "2.0.0");
    assert.equal(await readFile(join(alias, "1.0.0", "payload.txt"), "utf8"), "1.0.0");
  }));

for (const kind of ["empty-file", "directory", "symlink", "wrong-owner"] as const) {
  test(`an invalid ${kind} seed marker does not retain ordinary downloaded cache`, async () =>
    fixture(async (root, storageRoot) => {
      const first = await install(root, storageRoot, "zcode-plugins-official", "1.0.0");
      const second = await install(root, storageRoot, "zcode-plugins-official", "2.0.0");
      const marker = join(first.installPath, ".zcode-plugin-seed.json");
      const outside = join(root, "outside-marker.json");
      const content = {
        version: 1,
        marketplace: "zcode-plugins-official",
        plugin: "owned-note",
        pluginVersion: "1.0.0",
        source: "filesystem",
        hash: "a".repeat(64),
      };
      await json(outside, content);
      if (kind === "empty-file") await writeFile(marker, "");
      else if (kind === "directory") await mkdir(marker);
      else if (kind === "symlink") await symlink(outside, marker, "file");
      else await json(marker, { ...content, plugin: "another-plugin" });
      await uninstallMarketplacePlugin({ storageRoot, pluginId: second.id, removeCache: true });
      await assert.rejects(
        realpath(join(storageRoot, "cache", "zcode-plugins-official", "owned-note")),
        { code: "ENOENT" },
      );
      assert.deepEqual(JSON.parse(await readFile(outside, "utf8")), content);
      assert.equal(listInstalledPluginRecords(storageRoot).length, 0);
    }));
}
