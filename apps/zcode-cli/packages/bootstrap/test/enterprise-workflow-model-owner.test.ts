import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRootTraceContext,
  type ExecutionPort,
  type ModelRequestAdmission,
} from "@zcode/contracts";
import { createWorkflowExecutionAdmission, type AgentRuntime } from "@zcode/core";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { InMemoryJournalStore, type WorkflowReportSink } from "@zcode/dynamic-workflow";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";
import type { WorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import { withWorkflowModelAdmission } from "../src/app/workflow-model-admission.js";
import { seedActorSession } from "../src/app/workflow-driver-transcript.js";
import { createCoreError, CoreErrorType, type SessionId } from "@zcode/contracts";
import type { AgentRuntimeWorkflowDriverDeps } from "../src/app/workflow-driver-types.js";
import { buildImportedCache } from "../src/app/dynamic-workflow-import.js";

test("actor model admission remains bound to its original run owner for every later attempt", async () => {
  let owner = "a".repeat(64),
    admission: ModelRequestAdmission | undefined;
  const fence = await createWorkflowExecutionAdmission({
    sessionId: "controlled",
    workspacePath: "/controlled",
    workingDirectory: "/controlled",
    traceContext: createRootTraceContext(),
    authorization: { authorize: async () => ({ allowed: true, code: "allowed", ownerKey: owner }) },
  });
  const driver = createAgentRuntimeWorkflowDriver({
    journal: new InMemoryJournalStore(),
    emit: () => {},
    cwd: "/controlled",
    fileSystemPort: createNodeFileSystemAdapter(),
    executionPort: {} as ExecutionPort,
    escalationRegistry: {} as WorkflowEscalationRegistry,
    admission: fence,
    runtimeFactory: (input) => {
      admission = input.modelRequestAdmission;
      return {} as AgentRuntime;
    },
  })({} as WorkflowReportSink);
  await driver.createActorSession({ siteId: "actor#1", ordinal: 1 }, {});
  assert.ok(
    admission,
    "even without a concurrency governor each actor must receive the run owner gate",
  );
  const ticket = await admission.acquire({
    model: { providerId: "controlled", modelId: "controlled" },
  });
  ticket.release();
  owner = "b".repeat(64);
  await assert.rejects(
    admission.acquire({ model: { providerId: "controlled", modelId: "controlled" } }),
    /enterprise_identity_changed/,
  );
  driver.dispose?.();
});

test("a queued model ticket is released if the original run owner changes while waiting", async () => {
  let owner = "a".repeat(64),
    released = 0;
  const fence = await createWorkflowExecutionAdmission({
    sessionId: "controlled",
    workspacePath: "/controlled",
    workingDirectory: "/controlled",
    traceContext: createRootTraceContext(),
    authorization: { authorize: async () => ({ allowed: true, code: "allowed", ownerKey: owner }) },
  });
  const admission = withWorkflowModelAdmission(
    { admission: fence },
    {
      acquire: async () => {
        owner = "b".repeat(64);
        return {
          publish() {},
          release() {
            released++;
          },
        };
      },
    },
  );
  await assert.rejects(
    admission!.acquire({ model: { providerId: "controlled", modelId: "controlled" } }),
    /enterprise_identity_changed/,
  );
  assert.equal(released, 1);
});

test("transcript seed does not copy old source bytes or resume after owner change during its read", async () => {
  let allowed = true,
    writes = 0,
    resumes = 0;
  const admission = {
    revalidate: async () => {
      if (!allowed)
        throw createCoreError(CoreErrorType.PermissionDenied, "enterprise_identity_changed", {
          context: { source: "enterprise-policy" },
        });
    },
  };
  const deps = {
    admission,
    actorTranscriptStore: {
      messages: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === "target") return [];
        allowed = false;
        return [
          {
            info: { id: "old-message", sessionID: "source", role: "user", time: { created: 1 } },
            parts: [
              {
                id: "old-part",
                messageID: "old-message",
                sessionID: "source",
                type: "text",
                text: "CONTROLLED_OLD_OWNER_TRANSCRIPT",
              },
            ],
          },
        ];
      },
      saveMessage: async () => {
        writes++;
      },
      savePart: async () => {
        writes++;
      },
    },
  } as unknown as AgentRuntimeWorkflowDriverDeps;
  await assert.rejects(
    seedActorSession(deps, {
      journaledSessionId: undefined,
      runtime: {
        resumeFromStore: async () => {
          resumes++;
        },
      } as unknown as AgentRuntime,
      seed: { sourceSessionId: "source", messageCount: 1 } as never,
      sessionId: "target" as SessionId,
    }),
    /enterprise_identity_changed/,
  );
  assert.equal(writes, 0);
  assert.equal(resumes, 0);
});

test("revocation after a committed seed message prevents later part writes without pretending to roll back", async () => {
  let allowed = true,
    messages = 0,
    parts = 0,
    resumes = 0;
  const admission = {
    revalidate: async () => {
      if (!allowed)
        throw createCoreError(CoreErrorType.PermissionDenied, "enterprise_filesystem_denied", {
          context: { source: "enterprise-policy" },
        });
    },
  };
  const deps = {
    admission,
    actorTranscriptStore: {
      messages: async ({ sessionID }: { sessionID: string }) =>
        sessionID === "target"
          ? []
          : [
              {
                info: {
                  id: "old-message",
                  sessionID: "source",
                  role: "user",
                  time: { created: 1 },
                },
                parts: [
                  {
                    id: "old-part",
                    messageID: "old-message",
                    sessionID: "source",
                    type: "text",
                    text: "CONTROLLED_SEED_BODY",
                  },
                ],
              },
            ],
      saveMessage: async () => {
        messages++;
        allowed = false;
      },
      savePart: async () => {
        parts++;
      },
    },
  } as unknown as AgentRuntimeWorkflowDriverDeps;
  await assert.rejects(
    seedActorSession(deps, {
      journaledSessionId: undefined,
      runtime: {
        resumeFromStore: async () => {
          resumes++;
        },
      } as unknown as AgentRuntime,
      seed: { sourceSessionId: "source", messageCount: 1 } as never,
      sessionId: "target" as SessionId,
    }),
    /enterprise_filesystem_denied/,
  );
  assert.equal(messages, 1);
  assert.equal(parts, 0);
  assert.equal(resumes, 0);
});

test("amend import cannot downgrade a transcript owner failure into an empty cache or read another actor", async () => {
  const journal = new InMemoryJournalStore();
  journal.createRun({
    runId: "old",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
    status: "completed",
  });
  for (const ordinal of [1, 2]) {
    journal.putActor({
      runId: "old",
      siteId: `actor#${ordinal}`,
      ordinal: 1,
      name: `controlled-${ordinal}`,
      persona: { name: `controlled-${ordinal}` },
      sessionId: `source-${ordinal}`,
    });
    journal.putNode({
      runId: "old",
      siteId: `ask#${ordinal}`,
      ordinal: 1,
      kind: "ask",
      status: "completed",
      inputHash: "controlled",
      actorSiteId: `actor#${ordinal}`,
      actorOrdinal: 1,
      actorSeq: 0,
      messageBoundary: 1,
      result: "controlled result",
    });
  }
  let allowed = true,
    reads = 0;
  const admission = {
    revalidate: async () => {
      if (!allowed)
        throw createCoreError(CoreErrorType.PermissionDenied, "enterprise_identity_changed", {
          context: { source: "enterprise-policy" },
        });
    },
  };
  const store = {
    messages: async () => {
      reads++;
      allowed = false;
      return [];
    },
    saveMessage: async () => {},
    savePart: async () => {},
  };
  await assert.rejects(
    buildImportedCache({ journal, actorTranscriptStore: store, admission }, "old"),
    /enterprise_identity_changed/,
  );
  assert.equal(reads, 1);
});
