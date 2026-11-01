import assert from "node:assert/strict";
import { test } from "node:test";
import type { UWorkClientPresentation } from "@zcode/shared";
import { resolveFeedbackEntryPolicy } from "../src/feedback/feedbackEntryPolicy.js";
import { useFeedbackStore } from "../src/feedback/feedbackStore.js";

const ready = (): Extract<UWorkClientPresentation, { status: "ready" }> => ({
  status: "ready",
  version: 0,
  welcome: "",
  riskNotice: "Verify",
  riskPrefix: "AI",
  scenes: { status: "unsupported" },
  desktop: { status: "unsupported" },
  pluginStore: { status: "unsupported" },
  help: {
    status: "ready",
    version: 0,
    data: {
      communityUrls: { "zh-CN": null, "en-US": null },
      feedback: { mode: "disabled", url: null },
    },
  },
});

test("only an explicitly unmanaged presentation can mount legacy feedback", () => {
  assert.equal(resolveFeedbackEntryPolicy({ status: "unmanaged" }), "legacy");
  for (const view of [null, { status: "unavailable" } as const])
    assert.equal(resolveFeedbackEntryPolicy(view), "unavailable");
  const view = ready();
  assert.equal(resolveFeedbackEntryPolicy(view), "disabled");
  view.help = { status: "unsupported" };
  assert.equal(resolveFeedbackEntryPolicy(view), "unavailable");
  view.help = {
    status: "ready",
    version: 2,
    data: {
      communityUrls: { "zh-CN": null, "en-US": null },
      feedback: { mode: "external", url: "https://help.example.test/feedback" },
    },
  };
  assert.equal(resolveFeedbackEntryPolicy(view), "external");
});

test("all direct feedback entry intents have a serial that closing does not replay", () => {
  const first = useFeedbackStore.getState().intentVersion;
  useFeedbackStore.getState().openSubmit();
  useFeedbackStore.getState().openFeatureRequest();
  useFeedbackStore.getState().openTickets();
  useFeedbackStore.getState().openSubmissionJob("owned");
  assert.equal(useFeedbackStore.getState().intentVersion, first + 4);
  useFeedbackStore.getState().close();
  assert.equal(useFeedbackStore.getState().intentVersion, first + 4);
  assert.equal(useFeedbackStore.getState().open, false);
  assert.equal(useFeedbackStore.getState().featureRequestOpen, false);
});
