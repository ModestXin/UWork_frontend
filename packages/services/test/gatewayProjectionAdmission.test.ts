import { test } from "node:test";
import assert from "node:assert/strict";
import { createGatewayProjectionAdmission } from "../src/ucas-gateway/gatewayProjectionAdmission.js";
import type { GatewayIdentityScope } from "../src/ucas-gateway/gatewayIdentityScope.js";

test("an old asynchronous projection inspection cannot clear a newer admission", async () => {
  let release!: () => void,
    entered!: () => void,
    cleared = 0;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const identity: GatewayIdentityScope = {
    managed: true,
    isCurrent: () => true,
    async assertCurrent() {},
  };
  const old: GatewayIdentityScope = {
    ...identity,
    async assertCurrent() {
      entered();
      await blocked;
      throw new Error("previous projection invalid");
    },
  };
  const admission = createGatewayProjectionAdmission({
    provisioning: {
      async listModels() {
        return [];
      },
      async apply() {
        return { apiKeyApplied: false, hasApiKey: false, modelsAdded: 0, modelsSkipped: 0 };
      },
    },
    clearProjection() {
      cleared++;
    },
    publishFailure() {},
    onRejection() {},
    onClearFailure() {},
  });
  const scope = admission.bind(identity);
  const pending = admission.prepare(
    scope,
    old,
    "https://controlled.invalid/v1",
    "https://controlled.invalid",
  );
  await reached;
  admission.advance();
  release();
  await assert.rejects(pending);
  assert.equal(cleared, 0, "a late old inspection must not clear the newer projection");
});
