import assert from "node:assert/strict";
import { test } from "node:test";
import { RendererUserActionTelemetry } from "../src/lib/userActionTelemetry.js";
import type { RendererActionTraceBatchV1 } from "@zcode/shared";

test("changing the bound epoch discards completed and still-active renderer spans", async () => {
  const sent: RendererActionTraceBatchV1[] = [];
  const config = {
    enabled: true,
    sampleRatio: 0.2,
    enabledGroups: ["settings" as const],
    configVersion: "1",
    bindingEpoch: "owner-a",
  };
  const telemetry = new RendererUserActionTelemetry({
    config,
    random: () => 0,
    resource: {
      serviceName: "zcode-desktop-renderer",
      serviceVersion: "test",
      deploymentEnvironment: "test",
      rendererInstanceId: "controlled",
    },
    sendBatch: (batch) => {
      sent.push(batch);
    },
  });
  const completed = telemetry.start({
    featureId: "settings.appearance",
    action: "change_theme",
    trigger: "select",
  });
  completed.complete();
  const active = telemetry.start({
    featureId: "settings.appearance",
    action: "change_theme",
    trigger: "select",
  });
  telemetry.updateConfig({ ...config, bindingEpoch: "owner-b" });
  active.complete();
  await telemetry.flush();
  assert.equal(sent.length, 0);
  telemetry
    .start({ featureId: "settings.appearance", action: "change_theme", trigger: "select" })
    .complete();
  await telemetry.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent.at(0)?.bindingEpoch, "owner-b");
  await telemetry.shutdown();
});
