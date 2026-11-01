import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEnterpriseAssetStore } from "../src/enterprise-assets/assetStore.js";

const operation = { traceId: "controlled-selection", isCurrent: () => true };
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "uwork-selection-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "cache");
  return {
    directory,
    root,
    store: createEnterpriseAssetStore({ root }),
    other: createEnterpriseAssetStore({ root }),
  };
}
function bundle(version: number) {
  const content = {
    files: [{ path: "SKILL.md", content: `controlled ${version}` }],
    highRisk: false,
  };
  return {
    id: "controlled",
    kind: "skill",
    version,
    content,
    checksum: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}

test("selection revisions fence independent stores and unconditional cleanup invalidates old selections", async (t) => {
  const f = await fixture(t);
  const initial = await f.store.readSelectionRevision(operation);
  assert.equal(initial, null);
  const first = await f.store.materialize(bundle(1), operation);
  assert.equal(
    await f.other.readSelectionRevision(operation),
    initial,
    "materialization does not confer selection",
  );
  const selected = await f.store.select(initial, [first.key], operation);
  const second = await f.other.materialize(bundle(2), operation);
  const next = await f.other.select(selected, [second.key], operation);
  assert.notEqual(next, selected);
  await assert.rejects(() => f.store.select(selected, [first.key], operation), {
    code: "enterprise_asset_selection_changed",
  });
  assert.equal((await f.other.verify(second.key, operation)).key, second.key);
  assert.equal(
    (await readdir(f.root)).some((name) => name.startsWith("stage-")),
    false,
  );
  await f.store.prune([], operation);
  await assert.rejects(() => f.other.select(next, [], operation), {
    code: "enterprise_asset_selection_changed",
  });
  assert.ok(await f.other.readSelectionRevision(operation));
});

test("unsafe or corrupt selection metadata is preserved and cannot authorize destructive pruning", async (t) => {
  for (const mode of ["symlink", "corrupt", "owner"] as const) {
    const f = await fixture(t),
      asset = await f.store.materialize(bundle(1), operation);
    const personal = join(f.directory, "personal.txt");
    await writeFile(personal, "personal untouched");
    const path = join(f.root, ".selection.json");
    if (mode === "symlink") await symlink(personal, path);
    else
      await writeFile(
        path,
        mode === "corrupt"
          ? "invalid"
          : JSON.stringify({
              format: "uwork.enterprise-selection/v1",
              owner: "11111111-1111-4111-8111-111111111111",
              revision: "22222222-2222-4222-8222-222222222222",
            }),
      );
    await assert.rejects(() => f.store.prune([], operation));
    assert.equal(await readFile(personal, "utf8"), "personal untouched");
    assert.equal(await readFile(join(asset.directory, "SKILL.md"), "utf8"), "controlled 1");
    assert.ok(await readFile(path));
  }
});
