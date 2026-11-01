import { test } from "node:test";
import assert from "node:assert/strict";
import { zcodeEnterpriseToolAuthorizationParamsSchema } from "../src/zcode-protocol/index.js";

const dispatch = {
  requestId: "memory-request",
  toolCallId: "memory-call",
  sessionId: "memory-session",
  workspace: { workspaceKey: "/controlled", workspacePath: "/controlled" },
  workingDirectory: "/controlled",
  toolName: "ProjectMemoryManifestRead",
  phase: "before_dispatch",
  input: { kind: "project-memory-manifest" },
  capability: {
    permission: "filesystem",
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
  },
};
const parses = (value: unknown) => zcodeEnterpriseToolAuthorizationParamsSchema.safeParse(value);

test("the fixed Memory manifest consumer carries only its kind through dispatch and owner-bound release", () => {
  for (const phase of ["before_dispatch", "before_result"])
    for (const ownerKey of phase === "before_result" ? [undefined, "a".repeat(64)] : [undefined]) {
      const result = parses({ ...dispatch, phase, ...(ownerKey ? { ownerKey } : {}) });
      assert.equal(result.success, true, `${phase}, owner=${ownerKey !== undefined}`);
      if (result.success) {
        assert.deepEqual(result.data.input, { kind: "project-memory-manifest" });
        assert.equal(result.data.toolCallId, dispatch.toolCallId);
      }
    }
});

test("Memory manifest authorization input cannot transport paths, content or extra metadata", () => {
  for (const input of [
    undefined,
    null,
    "project-memory-manifest",
    {},
    { kind: "file" },
    { kind: "project-memory-manifest", path: "/controlled/MEMORY.md" },
    { kind: "project-memory-manifest", root: "/controlled" },
    { kind: "project-memory-manifest", body: "SYNTHETIC_PRIVATE_MEMORY_BODY" },
    { kind: "project-memory-manifest", metadata: {} },
  ])
    for (const phase of ["before_dispatch", "before_result"])
      assert.equal(parses({ ...dispatch, input, phase }).success, false, JSON.stringify(input));
});

test("Memory manifest admission accepts only the exact readonly filesystem capability and two phases", () => {
  for (const capability of [
    { ...dispatch.capability, permission: "read" },
    { ...dispatch.capability, readOnly: false },
    { ...dispatch.capability, destructive: true },
    { ...dispatch.capability, sideEffectScope: "workspace" },
    { ...dispatch.capability, sideEffectScope: "network" },
    { ...dispatch.capability, networkGuarded: false },
    { ...dispatch.capability, assetGuarded: false },
  ])
    assert.equal(parses({ ...dispatch, capability }).success, false);
  for (const phase of ["before_hooks", "native_execution", "network_request", "asset_load"])
    assert.equal(parses({ ...dispatch, phase, ownerKey: "a".repeat(64) }).success, false);
  assert.equal(parses({ ...dispatch, ownerKey: "a".repeat(64) }).success, false);
  for (const ownerKey of ["bad-owner", "a".repeat(63), "A".repeat(64)])
    assert.equal(parses({ ...dispatch, phase: "before_result", ownerKey }).success, false);
  assert.equal(parses({ ...dispatch, sessionId: "" }).success, false);
  assert.equal(parses({ ...dispatch, workspace: {} }).success, false);
});

test("Memory manifest consumer does not open result release for arbitrary readonly filesystem names", () => {
  assert.equal(
    parses({
      ...dispatch,
      toolName: "ProjectMemoryIndexRead",
      input: { kind: "project-memory-index" },
      phase: "before_result",
    }).success,
    true,
  );
  assert.equal(
    parses({ ...dispatch, toolName: "ArbitraryExistingTool", input: { existing: true } }).success,
    true,
    "unknown names keep original generic dispatch rules",
  );
  for (const toolName of [
    "ProjectMemoryRead",
    "projectMemoryManifestRead",
    "Write",
    "ArbitraryConsumer",
  ])
    assert.equal(parses({ ...dispatch, toolName, phase: "before_result" }).success, false);
  assert.equal(
    parses({
      ...dispatch,
      toolName: "Read",
      phase: "before_result",
      input: { file_path: "/controlled/owned.txt" },
      capability: { ...dispatch.capability, permission: "read" },
    }).success,
    true,
  );
  assert.equal(
    parses({
      ...dispatch,
      toolName: "PromptAttachmentRead",
      phase: "before_result",
      input: { path: "/controlled/owned.txt", kind: "file" },
    }).success,
    true,
  );
});

test("internal manifest proof cannot transport model tool-call or catalog fields", () => {
  for (const input of [
    { kind: "project-memory-manifest", tool_calls: [] },
    { kind: "project-memory-manifest", tools: [] },
    { kind: "project-memory-manifest", arguments: "{}" },
    { kind: "project-memory-manifest", root: "/owned" },
  ])
    assert.equal(parses({ ...dispatch, input }).success, false);
  assert.equal(parses({ ...dispatch, tools: [] }).success, false);
});
