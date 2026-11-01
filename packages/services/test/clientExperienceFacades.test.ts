import assert from "node:assert/strict";
import { test } from "node:test";
import type { UWorkClientPresentation } from "@zcode/shared";
import { createClientScenesService } from "../src/client-scenes/clientScenesService.js";
import { createClientConfigService } from "../src/client-config/clientConfigService.js";

const ready = (): UWorkClientPresentation => ({
  status: "ready",
  version: 1,
  welcome: "Hello",
  riskNotice: "Verify",
  riskPrefix: "AI",
  scenes: {
    status: "ready",
    version: 2,
    data: {
      draftSuggestions: [
        {
          id: "draft",
          title: { en: "Draft" },
          prompt: { en: "Write" },
          actions: ["NAVIGATE:AUTOMATIONS"],
          pluginStableId: "opaque-metadata",
        },
      ],
      scheduledTemplates: [
        {
          id: "daily",
          title: { en: "Daily" },
          prompt: { en: "Summarize" },
          cronExpr: "0 9 * * 1-5",
        },
      ],
      offPeakTemplates: [
        {
          id: "review",
          title: { en: "Review" },
          prompt: { en: "Review changes" },
          description: { en: "Description" },
        },
      ],
    },
  },
  help: { status: "unsupported" },
  desktop: { status: "unsupported" },
  pluginStore: {
    status: "ready",
    version: 3,
    data: { order: { work: { categoryOrder: ["owned"] } } },
  },
});

test("scene and plugin facades read the same current projection on every call without a TTL cache", async () => {
  let view = ready(),
    reads = 0;
  const readClientPresentation = async () => {
    reads++;
    return view;
  };
  const scenes = createClientScenesService({ readClientPresentation });
  const config = createClientConfigService({ readClientPresentation });
  const result = await scenes.list();
  assert.equal(result.code, 0);
  assert.deepEqual(
    result.data.map((scene) => scene.namespace),
    ["uwork", "uwork", "uwork"],
  );
  const draft = result.data[0]!.options.prompts!.items![0]!;
  assert.deepEqual(draft.labels, { en: "Draft" });
  assert.equal(draft.on_finish, "NAVIGATE:AUTOMATIONS");
  assert.equal(
    draft.defaults,
    undefined,
    "opaque metadata cannot trigger the existing install grammar",
  );
  assert.deepEqual(await config.getSnapshot(), {
    pluginStoreOrder: { work: { categoryOrder: ["owned"] } },
  });
  const next = ready();
  if (next.status === "ready")
    next.pluginStore = { status: "ready", version: 4, data: { order: null } };
  view = next;
  assert.deepEqual(await config.getSnapshot(), { pluginStoreOrder: null });
  assert.equal(reads, 3);
});

test("unavailable or unsupported managed kinds are not disguised as successful empty data", async () => {
  let view = ready();
  const readClientPresentation = async () => view;
  const scenes = createClientScenesService({ readClientPresentation });
  const config = createClientConfigService({ readClientPresentation });
  if (view.status === "ready") {
    view.scenes = { status: "unsupported" };
    view.pluginStore = { status: "unavailable" };
  }
  await assert.rejects(scenes.list(), /enterprise_client_scenes_unsupported/);
  await assert.rejects(config.getSnapshot(), /enterprise_client_plugin_store_unavailable/);
  view = { status: "unavailable" };
  await assert.rejects(scenes.list(), /enterprise_client_scenes_unavailable/);
  await assert.rejects(config.getSnapshot(), /enterprise_client_plugin_store_unavailable/);
  view = { status: "unmanaged" };
  assert.deepEqual((await scenes.list()).data, []);
  assert.deepEqual(await config.getSnapshot(), { pluginStoreOrder: null });
});
