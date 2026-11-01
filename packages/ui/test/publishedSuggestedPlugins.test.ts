import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientSceneConfig } from "@zcode/services";
import type { ZCodePluginReferenceCatalogEntry } from "@zcode/shared";
import { mapClientScenesToDraftSuggestedPromptItems } from "../src/v4/draftSuggestedPromptItems.js";
import { revalidatePublishedInstalledPlugin } from "../src/v4/publishedSuggestedPlugins.js";

const entry = (
  patch: Partial<ZCodePluginReferenceCatalogEntry> = {},
): ZCodePluginReferenceCatalogEntry => ({
  pluginId: "owned@installed",
  name: "Owned",
  marketplace: "installed",
  enabled: true,
  conflictingPluginIds: [],
  skillQualifiedNames: [],
  mcpServerNames: [],
  subagentNames: [],
  ...patch,
});

test("selection rechecks the current installed catalog and never offers an install after revocation", async () => {
  let current = [entry()];
  let reads = 0;
  const read = async () => {
    reads++;
    return current;
  };
  assert.equal(
    (await revalidatePublishedInstalledPlugin("owned@installed", read))?.installedOnly,
    true,
  );
  current = [];
  assert.equal(await revalidatePublishedInstalledPlugin("owned@installed", read), undefined);
  current = [entry({ enabled: false })];
  assert.equal(await revalidatePublishedInstalledPlugin("owned@installed", read), undefined);
  assert.equal(
    await revalidatePublishedInstalledPlugin("owned@installed", async () => {
      throw Error("catalog unavailable");
    }),
    undefined,
  );
  assert.equal(reads, 3);
});
const scenes: ClientSceneConfig[] = [
  {
    namespace: "uwork",
    scene: "draft-suggestion",
    options: {
      prompts: {
        id: "prompts",
        type: "prompts",
        contents: {},
        items: [
          {
            id: "draft",
            type: "prompt",
            labels: { en: "Draft" },
            contents: { en: "Write" },
            pluginStableId: "owned@installed",
          },
        ],
      },
    },
  },
];

test("published plugin metadata binds only an exact enabled installed reference", () => {
  const items = mapClientScenesToDraftSuggestedPromptItems(scenes, [entry()]);
  assert.deepEqual(items[0]!.plugin, {
    stableId: "owned@installed",
    label: { cn: "Owned", en: "Owned" },
    installedOnly: true,
  });
});

test("missing, disabled, conflicted and revoked plugins preserve a plain prompt", () => {
  for (const catalog of [
    [],
    [entry({ pluginId: "other@installed" })],
    [entry({ enabled: false })],
    [entry({ conflictingPluginIds: ["conflict"] })],
  ]) {
    const item = mapClientScenesToDraftSuggestedPromptItems(scenes, catalog)[0]!;
    assert.equal(item.plugin, undefined);
    assert.deepEqual(item.prompt, { en: "Write" });
  }
});
