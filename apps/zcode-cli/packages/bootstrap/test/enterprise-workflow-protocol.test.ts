import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getSavedWorkflowOp } from "../src/zcode-protocol/saved-workflows.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

test("saved workflow public get rejects a foreign workspace before filesystem admission", async () => {
  let calls = 0;
  const workspace = {
    workspacePath: join(tmpdir(), randomUUID()),
    workspaceKey: "controlled",
    workspaceIdentity: "controlled",
  };
  const context = {
    deps: {
      enterpriseWorkspace: workspace,
      enterpriseToolAuthorization: {
        authorize: async () => {
          calls++;
          return { allowed: true, code: "allowed", ownerKey: "a".repeat(64) };
        },
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  await assert.rejects(
    getSavedWorkflowOp(context, {
      workspace: { ...workspace, workspacePath: join(tmpdir(), randomUUID()) },
      name: "missing",
    }),
    /enterprise_workspace_mismatch/,
  );
  assert.equal(calls, 0);
});

test("saved workflow public get checks current filesystem permission before definition lookup", async () => {
  let calls = 0;
  const workspace = {
    workspacePath: join(tmpdir(), randomUUID()),
    workspaceKey: "controlled",
    workspaceIdentity: "controlled",
  };
  const context = {
    deps: {
      enterpriseWorkspace: workspace,
      enterpriseToolAuthorization: {
        authorize: async () => {
          calls++;
          return { allowed: false, code: "enterprise_filesystem_denied" };
        },
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  await assert.rejects(
    getSavedWorkflowOp(context, { workspace, name: "missing" }),
    /enterprise_filesystem_denied/,
  );
  assert.equal(calls, 1);
});
