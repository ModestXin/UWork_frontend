import assert from "node:assert/strict";
import { test } from "node:test";
import { createRootTraceContext } from "@zcode/contracts";
import { createRuntimeAssetGuards } from "../src/app/enterprise-runtime-assets.js";
import { createEnterpriseSessionFetch } from "../../adapters/src/model/enterprise-session-fetch.js";

test("the model proof getter only exposes the invocation's first existing ALS owner", async () => {
  let owner = "a".repeat(64);
  const guards = createRuntimeAssetGuards({
    sessionId: "controlled",
    workspacePath: "/controlled",
    traceContext: createRootTraceContext(),
    authorization: { authorize: async () => ({ allowed: true, code: "allowed", ownerKey: owner }) },
  })!;
  assert.equal(guards.model.getOwnerKey(), undefined);
  await guards.model.scope()(async () => {
    await guards.model("https://backend.example.test/v1/chat/completions");
    assert.equal(guards.model.getOwnerKey(), "a".repeat(64));
    owner = "b".repeat(64);
    await assert.rejects(
      guards.model("https://backend.example.test/v1/chat/completions"),
      /enterprise_identity_changed/,
    );
    assert.equal(guards.model.getOwnerKey(), "a".repeat(64));
  });
  assert.equal(guards.model.getOwnerKey(), undefined);
});

test("session fetch fails closed before private open if no original invocation proof exists", async () => {
  let requests = 0;
  const relayFetch = createEnterpriseSessionFetch({
    sessionId: "controlled",
    workspacePath: "/controlled",
    traceContext: createRootTraceContext(),
    getOwnerKey: () => undefined,
    relay: {
      request: async () => {
        requests++;
        return { status: "denied", code: "must_not_open" };
      },
    },
  });
  await assert.rejects(
    relayFetch("https://backend.example.test/v1/chat/completions", { method: "POST", body: "{}" }),
    /enterprise_model_owner_required/,
  );
  assert.equal(requests, 0);
});

test("private open carries the original proof once without recapturing a replacement owner", async () => {
  let owner = "a".repeat(64),
    getters = 0;
  const frames: unknown[] = [];
  const relayFetch = createEnterpriseSessionFetch({
    sessionId: "controlled",
    workspacePath: "/controlled",
    traceContext: createRootTraceContext(),
    getOwnerKey: () => {
      getters++;
      return owner;
    },
    relay: {
      request: async (frame) => {
        frames.push(frame.request);
        owner = "b".repeat(64);
        return { status: "denied", code: "enterprise_identity_changed" };
      },
    },
  });
  await assert.rejects(
    relayFetch("https://backend.example.test/v1/chat/completions", {
      method: "POST",
      body: '{"controlled":"old-run-input"}',
    }),
    /enterprise_identity_changed/,
  );
  assert.equal(getters, 1);
  assert.equal((frames[0] as { ownerKey: string }).ownerKey, "a".repeat(64));
  assert.equal(frames.length, 1);
});
