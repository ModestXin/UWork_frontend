import assert from "node:assert/strict";
import { test } from "node:test";
import { createRendererActionTraceBroker } from "../src/main/rendererActionTraceBroker.js";
import {
  resolveBoundRendererTraceConfig,
  authorizeRendererTraceBatch,
} from "../src/main/clientPresentationTrace.js";

const bound = (status: "ready" | "unavailable" | "unmanaged" = "ready") => ({
  bindingEpoch: "controlled:1",
  projection:
    status === "ready"
      ? {
          status: "ready" as const,
          help: { status: "unsupported" as const },
          desktop: {
            status: "ready" as const,
            version: 1,
            data: {
              desktopContextPrompt: { enabled: true },
              rendererActionTrace: {
                enabled: false,
                sampleRatio: 0.1,
                enabledGroups: ["core" as const],
              },
            },
          },
        }
      : { status },
});
const batch = () => ({
  version: 1 as const,
  bindingEpoch: "controlled:1",
  rendererInstanceId: "controlled-renderer",
  sequence: 0,
  droppedSinceLastFlush: 0,
  resource: {
    serviceName: "zcode-desktop-renderer" as const,
    serviceVersion: "test",
    deploymentEnvironment: "test" as const,
    rendererInstanceId: "controlled-renderer",
  },
  spans: [
    {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "ui_action" as const,
      startTimeUnixMs: 1,
      endTimeUnixMs: 2,
      status: "ok" as const,
      attributes: {
        feature_id: "controlled",
        action: "open",
        catalog_group: "core" as const,
        operation_kind: "navigation" as const,
        surface: "settings",
        trigger: "button" as const,
        outcome: "completed" as const,
        action_id: "00000000-0000-4000-8000-000000000001",
      },
    },
  ],
});

test("managed trace decisions override debug while unmanaged preserves explicit local diagnostics", () => {
  const env = { ZCODE_RENDERER_ACTION_TRACE_ENABLED: "1", ZCODE_LOCAL_TTFT_ENABLED: "1" };
  const managed = resolveBoundRendererTraceConfig(bound(), env);
  assert.equal(managed.enabled, false);
  assert.equal(managed.sampleRatio, 0.1);
  assert.equal(managed.localTtftEnabled, true);
  assert.equal(resolveBoundRendererTraceConfig(bound("unavailable"), env).enabled, false);
  assert.equal(resolveBoundRendererTraceConfig(bound("unmanaged"), env).sampleRatio, 1);
  assert.equal(authorizeRendererTraceBatch(batch(), managed), false);
  assert.equal(authorizeRendererTraceBatch(batch(), { ...managed, enabled: true }), true);
  assert.equal(
    authorizeRendererTraceBatch(
      { ...batch(), bindingEpoch: "other:1" },
      { ...managed, enabled: true },
    ),
    false,
  );
});

test("broker rechecks the original binding before dispatch and before a retry", async () => {
  let exports = 0,
    allowed = true,
    checks = 0;
  const broker = createRendererActionTraceBroker({
    logger: { debug() {}, warn() {} },
    exporter: {
      export(_spans, done) {
        exports++;
        allowed = false;
        done({ code: 1 });
      },
      async shutdown() {},
    },
  });
  assert.equal(
    broker.enqueue(batch(), async () => {
      checks++;
      return allowed;
    }),
    true,
  );
  await broker.flush();
  assert.equal(exports, 1, "revoked queue entry cannot retry under a new decision");
  assert.equal(checks, 2);
  assert.equal(
    broker.enqueue(batch(), async () => false),
    true,
  );
  await broker.flush();
  assert.equal(exports, 1, "stale queued work never reaches the exporter");
  await broker.shutdown();
});
