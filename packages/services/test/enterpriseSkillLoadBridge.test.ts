import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "@zcode/rpc";
import { createEnterpriseToolAuthorizationBridge } from "../src/zcode-agent/enterpriseToolAuthorizationBridge.js";

const workspace = { workspaceKey: "controlled", workspacePath: "/controlled" };
const reference = {
  key: "a".repeat(64),
  asset: { id: "controlled", kind: "skill" as const, version: 1, checksum: "b".repeat(64) },
  directory: "/controlled/cache/content",
};
const request = {
  requestId: "enterprise-tool:load",
  sessionId: "child",
  workspace,
  toolName: "EnterpriseSkillLoad",
  toolCallId: "controlled",
  workingDirectory: "/controlled",
  phase: "asset_load",
  capability: {
    permission: "skill",
    sideEffectScope: "none",
    readOnly: true,
    destructive: false,
    assetGuarded: true,
  },
  input: {},
  asset: reference,
  ownerKey: "c".repeat(64),
};
function peer() {
  const close = new Emitter<void>(),
    results: unknown[] = [],
    errors: unknown[] = [];
  return {
    isDisposed: false,
    onClose: close.event,
    results,
    errors,
    respond: async (_id: string | number, value: unknown) => {
      results.push(value);
    },
    respondError: async (_id: string | number, value: unknown) => {
      errors.push(value);
    },
  };
}

test("asset-load RPC only delegates immutable references to the private asset owner, never generic execution admission", async () => {
  const client = peer(),
    seen: unknown[] = [];
  let generic = 0;
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    resolver: {
      async authorize() {
        generic++;
        return { allowed: true, code: "allowed" };
      },
    },
    assets: {
      async readCatalog() {
        return { status: "unmanaged" as const };
      },
      async authorizeAsset(value, traceId, signal) {
        seen.push(value);
        assert.equal(traceId, "controlled-trace");
        assert.equal(signal?.aborted, false);
        return { allowed: true, code: "allowed" };
      },
    },
  });
  await bridge.handle(client, workspace, 1, request, "controlled-trace");
  await bridge.handle(client, workspace, 2, { ...request, asset: undefined }, "controlled-trace");
  assert.deepEqual(seen, [reference, undefined]);
  assert.equal(generic, 0);
  assert.deepEqual(client.results, [
    { allowed: true, code: "allowed" },
    { allowed: true, code: "allowed" },
  ]);
});

test("asset-load requests cannot use a missing owner or malformed/foreign-phase asset reference", async () => {
  const client = peer();
  let generic = 0;
  const bridge = createEnterpriseToolAuthorizationBridge({
    isCurrent: () => true,
    resolver: {
      async authorize() {
        generic++;
        return { allowed: true, code: "allowed" };
      },
    },
  });
  await bridge.handle(client, workspace, 1, request, "controlled-trace");
  assert.deepEqual(client.results, [{ allowed: false, code: "enterprise_policy_unavailable" }]);
  await bridge.handle(
    client,
    workspace,
    2,
    { ...request, phase: "before_dispatch" },
    "controlled-trace",
  );
  await bridge.handle(
    client,
    workspace,
    3,
    { ...request, asset: { ...reference, token: "private" } },
    "controlled-trace",
  );
  assert.equal(client.errors.length, 2);
  assert.equal(generic, 0);
});
