import { test } from "node:test";
import assert from "node:assert/strict";
import { zcodeEnterpriseToolAuthorizationParamsSchema } from "../src/zcode-protocol/index.js";

const dispatch = {
  requestId: "attachment-request",
  toolCallId: "attachment-call",
  sessionId: "attachment-session",
  workspace: { workspaceKey: "/controlled", workspacePath: "/controlled" },
  workingDirectory: "/controlled",
  toolName: "PromptAttachmentRead",
  phase: "before_dispatch",
  input: { path: "/controlled/owned.txt", kind: "file" },
  capability: {
    permission: "filesystem",
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
  },
};
const parses = (value: unknown) => zcodeEnterpriseToolAuthorizationParamsSchema.safeParse(value);

test("the fixed attachment consumer supports both original phases and local path formats without trimming", () => {
  for (const kind of ["file", "image", "video", "pdf"])
    for (const path of [
      "/controlled/owned.txt ",
      "C:\\controlled\\owned.txt ",
      "C:/controlled/owned.txt",
      "\\\\server\\share\\owned.txt",
    ])
      for (const phase of ["before_dispatch", "before_result"]) {
        const value = {
          ...dispatch,
          phase,
          ...(phase === "before_result" ? { ownerKey: "a".repeat(64) } : {}),
          input: { path, kind },
        };
        const result = parses(value);
        assert.equal(result.success, true);
        if (result.success) assert.deepEqual(result.data.input, { path, kind });
      }
  assert.equal(
    parses({ ...dispatch, phase: "before_result" }).success,
    true,
    "unmanaged has no owner; managed Host must reject missing proof",
  );
});

test("attachment input is strict local metadata, never URI, relative path, body or arbitrary kind", () => {
  for (const input of [
    { path: "owned.txt", kind: "file" },
    { path: "https://example.test/owned.txt", kind: "file" },
    { path: "file:///controlled/owned.txt", kind: "file" },
    { path: "zcode-artifact://owned", kind: "file" },
    { path: "/controlled/owned\0.txt", kind: "file" },
    { path: "/controlled/owned.txt" },
    { path: "/controlled/owned.txt", kind: "url" },
    { path: "/controlled/owned.txt", kind: "file", body: "SYNTHETIC_NOT_AUTH_METADATA" },
  ])
    assert.equal(parses({ ...dispatch, input }).success, false);
});

test("only the exact readonly capability and two phases belong to the attachment consumer", () => {
  for (const capability of [
    { ...dispatch.capability, permission: "read" },
    { ...dispatch.capability, readOnly: false },
    { ...dispatch.capability, destructive: true },
    { ...dispatch.capability, sideEffectScope: "workspace" },
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

test("the new consumer leaves builtin Read and arbitrary-tool result restrictions unchanged", () => {
  const read = {
    ...dispatch,
    toolName: "Read",
    input: { file_path: "/controlled/owned.txt" },
    phase: "before_result",
    capability: { ...dispatch.capability, permission: "read" },
  };
  assert.equal(parses(read).success, true);
  assert.equal(parses({ ...read, ownerKey: "b".repeat(64) }).success, true);
  for (const toolName of ["Write", "Bash", "McpDispatch", "ArbitraryFilesystemConsumer"])
    assert.equal(
      parses({ ...dispatch, toolName, phase: "before_result", ownerKey: "a".repeat(64) }).success,
      false,
    );
});
