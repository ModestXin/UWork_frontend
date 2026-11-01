import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelSelectionView } from "@zcode/services";
import { buildRegistryModelSelectGroups } from "../src/lib/modelSelectionGroups.js";
import { resolveV4ModelTriggerDisplay } from "../src/v4/composer/modelTriggerDisplay.js";

test("enterprise selector and composer display metadata while keeping the exact encoded ID", () => {
  const view = {
    revision: 1,
    providers: [
      {
        providerId: "ucas",
        providerName: "ucas",
        config: {
          api: { type: "openai-chat-completions" },
          access: { type: "enterprise-session" },
        },
        models: [{ modelId: "opaque-billing-id", displayName: "联动受控模型", config: {} }],
      },
    ],
  } as unknown as ModelSelectionView;
  const groups = buildRegistryModelSelectGroups("glm", view);
  const item = groups[0]?.items[0];
  assert.equal(item?.name, "联动受控模型");
  assert.equal(item?.value, "custom:ucas:opaque-billing-id");
  assert.equal(item?.key, "registry-provider:ucas:opaque-billing-id");
  assert.deepEqual(
    resolveV4ModelTriggerDisplay({
      modelGroups: groups,
      normalizedValue: item!.value,
      fallbackLabel: "opaque-billing-id",
      providerId: "ucas",
      providerName: "ucas",
    }),
    { fullLabel: "ucas/联动受控模型", providerPrefix: "ucas/", modelLabel: "联动受控模型" },
  );
  delete (view.providers[0]!.models[0]! as { displayName?: string }).displayName;
  assert.equal(buildRegistryModelSelectGroups("glm", view)[0]?.items[0]?.name, "opaque-billing-id");
});
