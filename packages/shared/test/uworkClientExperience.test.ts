import assert from "node:assert/strict";
import { test } from "node:test";
import {
  uworkScenesConfigurationSchema,
  uworkHelpConfigurationSchema,
  uworkDesktopConfigurationSchema,
  uworkPluginStoreConfigurationSchema,
} from "../src/uwork-client-experience.js";
import { canVisualizeCronInAutomationEditor } from "../../ui/src/settings/automationFormat.js";
import { isValidCronExpr } from "../../services/src/session/automationCronValidation.js";

const scenes = () => ({ draftSuggestions: [], scheduledTemplates: [], offPeakTemplates: [] });
test("scheduled publication validation agrees with the real UI and scheduler golden examples", () => {
  const accepted = [
    "0 * * * *",
    "0 9 * * *",
    "0 9 * * 1-5",
    "30 8 * * 1,3,5",
    "0 9 15 * *",
    "*/15 * * * *",
    "0 */2 * * *",
    "0 9 */2 * *",
  ];
  const rejected = [
    "* * * * *",
    "0 9 * * 1-4",
    "0 9 * * 5,1",
    "0 9 * * 1#1",
    "0 9 1 1 *",
    "0 9 1 */2 *",
    "0 0 9 * * *",
    "00 9 * * *",
    "0 25 * * *",
    "*/60 * * * *",
  ];
  for (const cronExpr of [...accepted, ...rejected]) {
    const result = uworkScenesConfigurationSchema.safeParse({
      ...scenes(),
      scheduledTemplates: [
        { id: "daily", title: { en: "Daily" }, prompt: { en: "Read" }, cronExpr },
      ],
    });
    const expected = canVisualizeCronInAutomationEditor(cronExpr) && isValidCronExpr(cronExpr);
    assert.equal(result.success, expected, cronExpr);
    assert.equal(result.success, accepted.includes(cronExpr), cronExpr);
  }
});

test("strict data rejects executable fields, reserved aliases and oversized bounded content", () => {
  const item = { id: "one", title: { en: "Title" }, prompt: { en: "Prompt" } };
  assert.equal(
    uworkScenesConfigurationSchema.safeParse({
      ...scenes(),
      draftSuggestions: [{ ...item, on_finish: "execute" }],
    }).success,
    false,
  );
  assert.equal(
    uworkScenesConfigurationSchema.safeParse({ ...scenes(), draftSuggestions: [item, item] })
      .success,
    false,
  );
  for (const id of ["customize", "ITEM-CUSTOMIZE", "item_customize", "itemcustomize"])
    assert.equal(
      uworkScenesConfigurationSchema.safeParse({ ...scenes(), offPeakTemplates: [{ ...item, id }] })
        .success,
      false,
    );
  assert.equal(
    uworkScenesConfigurationSchema.safeParse({
      ...scenes(),
      draftSuggestions: [{ ...item, pluginStableId: "x".repeat(201) }],
    }).success,
    false,
  );
  assert.equal(
    uworkHelpConfigurationSchema.safeParse({
      communityUrls: { "zh-CN": "http://unsafe.test", "en-US": null },
      feedback: { mode: "disabled", url: null },
    }).success,
    false,
  );
  assert.equal(
    uworkHelpConfigurationSchema.safeParse({
      communityUrls: { "zh-CN": null, "en-US": null },
      feedback: { mode: "external", url: null },
    }).success,
    false,
  );
  assert.equal(
    uworkDesktopConfigurationSchema.safeParse({
      desktopContextPrompt: { enabled: false },
      rendererActionTrace: { enabled: true, sampleRatio: 1, enabledGroups: [] },
    }).success,
    false,
  );
  assert.equal(
    uworkPluginStoreConfigurationSchema.safeParse({
      order: { code: { categoryOrder: ["same", "same"] } },
    }).success,
    false,
  );
  assert.equal(
    uworkPluginStoreConfigurationSchema.safeParse({
      order: { code: { pluginOrder: { " collision ": ["one"], collision: ["two"] } } },
    }).success,
    false,
  );
});

test("UTF-8 publication budgets remain bounded even when individual localized strings are valid", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    title: { cn: "标题" },
    prompt: { cn: "汉".repeat(4000) },
  }));
  assert.equal(
    uworkScenesConfigurationSchema.safeParse({ ...scenes(), draftSuggestions: items }).success,
    false,
  );
  const url = `https://example.test/${"汉".repeat(1900)}`;
  assert.equal(
    uworkHelpConfigurationSchema.safeParse({
      communityUrls: { "zh-CN": url, "en-US": url },
      feedback: { mode: "external", url },
    }).success,
    false,
  );
});

test("malformed Help URLs fail validation without throwing outside safeParse", () => {
  for (const url of ["", "not-a-url", "https://", "javascript:alert(1)"])
    assert.doesNotThrow(() => {
      assert.equal(
        uworkHelpConfigurationSchema.safeParse({
          communityUrls: { "zh-CN": url, "en-US": null },
          feedback: { mode: "disabled", url: null },
        }).success,
        false,
      );
    }, url);
});

test("record keys cannot silently disappear during parsing", () => {
  const pluginOrder: unknown = JSON.parse('{"__proto__":["owned"]}');
  assert.equal(
    uworkPluginStoreConfigurationSchema.safeParse({ order: { code: { pluginOrder } } }).success,
    false,
  );
  assert.equal(
    uworkPluginStoreConfigurationSchema.safeParse({
      order: { code: { pluginOrder: { constructor: ["owned"], prototype: ["other"] } } },
    }).success,
    true,
  );
});
