import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  addMarketplace,
  ensureDefaultPluginMarketplaces,
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  uninstallMarketplacePlugin,
  updateMarketplace,
  type InstalledPluginRecord,
} from "../src/plugins/marketplace.js";
import {
  loadBundledOfficialPluginRootsSync,
  writeBundledOfficialMarketplacePartitionSync,
  writeCdnOfficialMarketplacePartitionSync,
} from "../src/plugins/official-marketplace.js";
const MARKET = "owned-market";
const NAME = "owned-plugin";
const OFFICIAL = "zcode-plugins-official";
const V1 = "1.0.0";
const V2 = "2.0.0";
const FALLBACK = "0.5.0";
const INSTALLED = "installed_plugins.json";
interface Fixture {
  root: string;
  storageRoot: string;
}
type Package = ReturnType<typeof pkg>;
async function fixture(t: TestContext, run: (value: Fixture) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uwork-uninstall-test-")));
  const storageRoot = join(root, "storage");
  await mkdir(storageRoot);
  // 只允许本机文件。若实现意外尝试目录下载，在真正建连前失败，而不是模拟成功。
  const network = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Unexpected network in filesystem-only regression");
  });
  try {
    await run({ root, storageRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
    assert.equal(network.mock.calls.length, 0);
  }
}
function pkg(f: Fixture, marketplace = MARKET, name = NAME) {
  return {
    ...f,
    marketplace,
    name,
    id: `${name}@${marketplace}`,
    source: join(f.root, "inputs", marketplace, name),
    manifest: join(f.root, "inputs", marketplace, "marketplace.json"),
    owner: join(f.storageRoot, "cache", marketplace, name),
  };
}
const json = (path: string, value: unknown) => marker(path, JSON.stringify(value));
async function marker(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function exists(path: string) {
  try {
    await realpath(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function publishVersion(
  p: Package,
  version: string,
  refresh = false,
  entryVersion: string | null = version,
) {
  await json(join(p.source, ".zcode-plugin", "plugin.json"), {
    name: p.name,
    version,
    description: "Owned filesystem fixture",
  });
  await marker(join(p.source, "payload.txt"), version);
  const entry = {
    name: p.name,
    ...(entryVersion === null ? {} : { version: entryVersion }),
    source: { source: "directory", path: p.source },
  };
  if (p.marketplace === OFFICIAL) {
    ensureDefaultPluginMarketplaces(p.storageRoot);
    writeCdnOfficialMarketplacePartitionSync({
      storageRoot: p.storageRoot,
      manifest: { name: OFFICIAL, plugins: [entry] },
    });
  } else {
    let entries: (typeof entry)[] = [];
    if (await exists(p.manifest))
      entries = (JSON.parse(await readFile(p.manifest, "utf8")) as { plugins: (typeof entry)[] })
        .plugins;
    await json(p.manifest, {
      name: p.marketplace,
      plugins: [...entries.filter((x) => x.name !== p.name), entry],
    });
    if (refresh) {
      const updated = await updateMarketplace({
        marketplace: p.marketplace,
        storageRoot: p.storageRoot,
      });
      assert.ok(updated.some((x) => x.id === p.marketplace));
    } else
      await addMarketplace({
        source: { source: "file", path: p.manifest },
        storageRoot: p.storageRoot,
      });
  }
}
const install = (p: Package) =>
  installMarketplacePlugin({
    marketplace: p.marketplace,
    name: p.name,
    storageRoot: p.storageRoot,
  });
async function installedVersion(
  p: Package,
  version: string,
  refresh = false,
): Promise<InstalledPluginRecord> {
  await publishVersion(p, version, refresh);
  const result = await install(p);
  const record = result.installed.find((x) => x.id === p.id);
  assert.ok(record);
  assert.equal(record.version, version);
  assert.equal(await readFile(join(record.installPath, "payload.txt"), "utf8"), version);
  return record;
}
async function twoVersions(p: Package) {
  const first = await installedVersion(p, V1);
  const second = await installedVersion(p, V2, p.marketplace !== OFFICIAL);
  assert.ok(await exists(first.installPath));
  assert.ok(await exists(second.installPath));
  assert.deepEqual(
    listInstalledPluginRecords(p.storageRoot)
      .filter((x) => x.id === p.id)
      .map((x) => x.version),
    [V2],
  );
  return { first, second };
}
async function data(p: Package) {
  const path = join(getPluginDataDir(p.storageRoot, p.id), "user-state.txt");
  await marker(path, "retain-unless-final-cleanup");
  return path;
}
const uninstall = (p: Package, options: { removeCache?: boolean; keepData?: boolean } = {}) =>
  uninstallMarketplacePlugin({
    pluginId: p.id,
    storageRoot: p.storageRoot,
    removeCache: true,
    ...options,
  });
test("final ordinary uninstall removes V1 and V2, preserving sources and neighboring owners", async (t) =>
  fixture(t, async (f) => {
    const p = pkg(f);
    await twoVersions(p);
    const userData = await data(p);
    const neighbor = pkg(f, MARKET, "neighbor");
    const otherMarket = pkg(f, "other-market");
    const neighboring = [
      await installedVersion(neighbor, V1),
      await installedVersion(otherMarket, V1),
    ];
    const before = await readFile(p.manifest);
    const workspaceConfig = join(f.root, "workspace", ".zcode", "config.json");
    await marker(workspaceConfig, "unrelated-workspace-config");
    const removed = await uninstall(p);
    assert.equal(removed?.version, V2);
    assert.equal(await exists(p.owner), false, "V1 must not survive an ordinary final uninstall");
    assert.equal(await exists(userData), false);
    assert.equal(
      listInstalledPluginRecords(f.storageRoot).some((x) => x.id === p.id),
      false,
    );
    assert.deepEqual(await readFile(p.manifest), before);
    assert.equal(await readFile(join(p.source, "payload.txt"), "utf8"), V2);
    assert.equal(await readFile(workspaceConfig, "utf8"), "unrelated-workspace-config");
    for (const record of neighboring)
      assert.equal(await readFile(join(record.installPath, "payload.txt"), "utf8"), V1);
    assert.deepEqual(
      listInstalledPluginRecords(f.storageRoot)
        .map((x) => x.id)
        .sort(),
      [neighbor.id, otherMarket.id].sort(),
    );
  }));
test("removeCache=false retains every cache version and data while removing the record", async (t) =>
  fixture(t, async (f) => {
    const p = pkg(f);
    const { first, second } = await twoVersions(p);
    const userData = await data(p);
    await uninstall(p, { removeCache: false });
    for (const record of [first, second])
      assert.equal(await readFile(join(record.installPath, "payload.txt"), "utf8"), record.version);
    assert.equal(await readFile(userData, "utf8"), "retain-unless-final-cleanup");
    assert.equal(listInstalledPluginRecords(f.storageRoot).length, 0);
  }));
test("keepData retains data but does not retain obsolete ordinary cache versions", async (t) =>
  fixture(t, async (f) => {
    const p = pkg(f);
    await twoVersions(p);
    const userData = await data(p);
    await uninstall(p, { keepData: true });
    assert.equal(await exists(p.owner), false);
    assert.equal(await readFile(userData, "utf8"), "retain-unless-final-cleanup");
  }));
test("legacy same-ID installations retain shared cache and data until the final removal", async (t) =>
  fixture(t, async (f) => {
    const p = pkg(f);
    const { first, second } = await twoVersions(p);
    const userData = await data(p);
    // 这是受支持的旧文件输入，不是伪造安装成功：两个版本此前均由实际 installer 建立。
    await json(join(f.storageRoot, INSTALLED), {
      version: 1,
      plugins: {
        [p.id]: [
          { ...first, scope: "project" },
          { ...second, scope: "user" },
        ],
      },
    });
    await uninstall(p);
    assert.deepEqual(
      listInstalledPluginRecords(f.storageRoot).map((x) => x.version),
      [V2],
    );
    for (const record of [first, second])
      assert.equal(await readFile(join(record.installPath, "payload.txt"), "utf8"), record.version);
    assert.equal(await readFile(userData, "utf8"), "retain-unless-final-cleanup");
    await uninstall(p);
    assert.equal(await exists(p.owner), false);
    assert.equal(await exists(userData), false);
  }));
test("an absent installed ID is a byte-identical no-op", async (t) =>
  fixture(t, async (f) => {
    const p = pkg(f);
    await installedVersion(p, V1);
    const before = await readFile(join(f.storageRoot, INSTALLED));
    assert.equal(await uninstall({ ...p, id: "absent@owned-market" }), null);
    assert.deepEqual(await readFile(join(f.storageRoot, INSTALLED)), before);
    assert.equal(await readFile(join(p.owner, V1, "payload.txt"), "utf8"), V1);
  }));
test("downloaded official owner without bundled ownership receives full version cleanup", async (t) =>
  fixture(t, async (f) => {
    const p = pkg(f, OFFICIAL);
    await twoVersions(p);
    assert.equal(loadBundledOfficialPluginRootsSync(f.storageRoot), undefined);
    await uninstall(p);
    assert.equal(await exists(p.owner), false);
  }));
test("a registered bundled root protects its whole official owner, including older fallback", async (t) =>
  fixture(t, async (f) => {
    const p = pkg(f, OFFICIAL);
    await twoVersions(p);
    const userData = await data(p);
    const bundled = join(p.owner, "3.0.0");
    const fallback = join(p.owner, FALLBACK);
    for (const path of [bundled, fallback]) {
      await json(join(path, ".zcode-plugin", "plugin.json"), {
        name: p.name,
        version: path === bundled ? "3.0.0" : FALLBACK,
      });
      await marker(join(path, "payload.txt"), "immutable-bundled-or-fallback");
    }
    writeBundledOfficialMarketplacePartitionSync({
      storageRoot: f.storageRoot,
      manifest: {
        name: OFFICIAL,
        plugins: [{ name: p.name, source: "filesystem", version: "3.0.0", cachePath: bundled }],
      },
    });
    assert.deepEqual(loadBundledOfficialPluginRootsSync(f.storageRoot), [bundled]);
    await uninstall(p);
    for (const version of [V1, V2])
      assert.equal(await readFile(join(p.owner, version, "payload.txt"), "utf8"), version);
    for (const path of [bundled, fallback])
      assert.equal(
        await readFile(join(path, "payload.txt"), "utf8"),
        "immutable-bundled-or-fallback",
      );
    assert.equal(await exists(userData), false);
  }));
test("seed-marked legacy bundled ownership protects same-name official versions without a partition", async (t) =>
  fixture(t, async (f) => {
    const p = pkg(f, OFFICIAL);
    await twoVersions(p);
    const seeded = join(p.owner, FALLBACK);
    await json(join(seeded, ".zcode-plugin", "plugin.json"), { name: p.name, version: FALLBACK });
    await json(join(seeded, ".zcode-plugin-seed.json"), {
      version: 1,
      marketplace: OFFICIAL,
      plugin: p.name,
      pluginVersion: FALLBACK,
      source: "filesystem",
      hash: "a".repeat(64),
    });
    assert.equal(loadBundledOfficialPluginRootsSync(f.storageRoot), undefined);
    await uninstall(p);
    for (const version of [V1, V2])
      assert.equal(await readFile(join(p.owner, version, "payload.txt"), "utf8"), version);
    assert.ok(await exists(join(seeded, ".zcode-plugin-seed.json")));
  }));
for (const field of ["marketplace", "name"] as const) {
  for (const component of ["..", "nested/escape"]) {
    test(`unsafe ${field} component ${component} rejects cleanup without deleting valid cache`, async (t) =>
      fixture(t, async (f) => {
        const p = pkg(f);
        const record = await installedVersion(p, V1);
        const changed = { ...record, [field]: component };
        changed.id = `${changed.name}@${changed.marketplace}`;
        await json(join(f.storageRoot, INSTALLED), { version: 1, plugins: [changed] });
        await assert.rejects(uninstall({ ...p, id: changed.id }));
        assert.equal(await readFile(join(record.installPath, "payload.txt"), "utf8"), V1);
        assert.equal(await readFile(join(p.source, "payload.txt"), "utf8"), V1);
        assert.equal(
          listInstalledPluginRecords(f.storageRoot).length,
          0,
          "record removal is persisted; cleanup failure is not rollback",
        );
      }));
  }
}
for (const ancestor of ["cache", "marketplace"] as const) {
  test(`a symlinked ${ancestor} ancestor cannot redirect recursive cleanup`, async (t) =>
    fixture(t, async (f) => {
      const p = pkg(f);
      await installedVersion(p, V1);
      const target =
        ancestor === "cache" ? join(f.storageRoot, "cache") : join(f.storageRoot, "cache", MARKET);
      const outside = join(f.root, "outside-cache");
      await rename(target, outside);
      await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(uninstall(p));
      const payload =
        ancestor === "cache"
          ? join(outside, MARKET, NAME, V1, "payload.txt")
          : join(outside, NAME, V1, "payload.txt");
      assert.equal(await readFile(payload, "utf8"), V1);
      assert.equal(listInstalledPluginRecords(f.storageRoot).length, 0);
    }));
}
test("a configured storage-root alias is resolved, while source inputs remain untouched", async (t) =>
  fixture(t, async (f) => {
    const alias = join(f.root, "storage-alias");
    await symlink(f.storageRoot, alias, process.platform === "win32" ? "junction" : "dir");
    const p = pkg({ ...f, storageRoot: alias });
    await twoVersions(p);
    await uninstall(p);
    assert.equal(await exists(join(f.storageRoot, "cache", MARKET, NAME)), false);
    assert.equal(await realpath(alias), f.storageRoot);
    assert.equal(await readFile(join(p.source, "payload.txt"), "utf8"), V2);
  }));
for (const version of [".", "..", ""]) {
  test(`unsafe final cache version ${JSON.stringify(version)} rejects before activation or record commit`, async (t) =>
    fixture(t, async (f) => {
      const p = pkg(f);
      const current = await installedVersion(p, V1);
      const neighbor = pkg(f, MARKET, "neighbor");
      const protectedRecord = await installedVersion(neighbor, V1);
      const before = await readFile(join(f.storageRoot, INSTALLED));
      await publishVersion(p, version, true);
      // 只包真正安装 API；helper 中的预期断言不得冒充被测实现拒绝。
      await assert.rejects(install(p));
      assert.deepEqual(await readFile(join(f.storageRoot, INSTALLED)), before);
      assert.equal(await readFile(join(current.installPath, "payload.txt"), "utf8"), V1);
      assert.equal(await readFile(join(protectedRecord.installPath, "payload.txt"), "utf8"), V1);
    }));
}
test("missing cache version falls back normally, and non-semver versions stay supported", async (t) =>
  fixture(t, async (f) => {
    const p = pkg(f);
    await publishVersion(p, "", false, null);
    const fallback = await install(p);
    assert.equal(fallback.installed[0]?.version, "0.0.0");
    assert.equal(await readFile(join(p.owner, "0.0.0", "payload.txt"), "utf8"), "");
    await installedVersion(p, "release-candidate", true);
    assert.equal(
      await readFile(join(p.owner, "release-candidate", "payload.txt"), "utf8"),
      "release-candidate",
    );
  }));
