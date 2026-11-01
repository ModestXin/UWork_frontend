import assert from "node:assert/strict";
import { createRootTraceContext } from "@zcode/contracts";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { test } from "node:test";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { startSavedWorkflowRun } from "../src/runtime/methods/dynamic-workflow-run-start.js";
import { createWorkflowExecutionAdmission } from "../src/runtime/helpers/workflow-execution-authorization.js";
import { createWorkflowAdmission } from "../src/runtime/methods/workflow-authorization.js";
import { saveSavedWorkflow } from "../src/tool/handlers/saved-workflows/index.js";
import { writeWorkflowDraft } from "../src/tool/handlers/workflow-drafts.js";

const ownerA = "a".repeat(64),
  ownerB = "b".repeat(64);
const context = {
  sessionId: "controlled-session",
  workspacePath: "/controlled/workspace",
  workingDirectory: "/controlled/workspace",
  traceContext: createRootTraceContext(),
};

test("workflow operation rejects owner or managed-mode changes and missing managed owner binding", async () => {
  for (const changed of [
    { allowed: true, code: "allowed", ownerKey: ownerB },
    { allowed: true, code: "not_managed" },
    { allowed: true, code: "allowed" },
  ]) {
    let calls = 0;
    const admission = await createWorkflowExecutionAdmission({
      ...context,
      authorization: {
        authorize: async () =>
          ++calls === 1 ? { allowed: true, code: "allowed", ownerKey: ownerA } : changed,
      },
    });
    await assert.rejects(
      admission.revalidate(),
      /enterprise_identity_changed|enterprise_policy_unavailable/,
    );
  }
});

test("workflow operation rechecks permission and refuses late uncooperative authorization after cancellation", async () => {
  let allowed = true;
  const admission = await createWorkflowExecutionAdmission({
    ...context,
    authorization: {
      authorize: async () =>
        allowed
          ? { allowed: true, code: "allowed", ownerKey: ownerA }
          : { allowed: false, code: "enterprise_filesystem_denied" },
    },
  });
  allowed = false;
  await assert.rejects(admission.revalidate(), /enterprise_filesystem_denied/);
  const abort = new AbortController();
  let release!: (value: { allowed: boolean; code: string; ownerKey: string }) => void;
  const pending = createWorkflowExecutionAdmission({
    ...context,
    signal: abort.signal,
    authorization: {
      authorize: () =>
        new Promise((done) => {
          release = done;
        }),
    },
  });
  abort.abort();
  await assert.rejects(pending, /enterprise_authorization_cancelled/);
  release({ allowed: true, code: "allowed", ownerKey: ownerA });
});

test("standalone and explicit unmanaged workflow operations retain their existing behavior", async () => {
  await (await createWorkflowExecutionAdmission(context)).revalidate();
  await (
    await createWorkflowExecutionAdmission({
      ...context,
      authorization: { authorize: async () => ({ allowed: true, code: "not_managed" }) },
    })
  ).revalidate();
});

test("current enterprise filesystem denial precedes saved definition lookup and run creation", async () => {
  let admissions = 0;
  const cwd = join(tmpdir(), `uwork-workflow-source-${randomUUID()}`);
  const runtime = {
    workingDirectory: cwd,
    workspaceRoot: cwd,
    config: { memory: { workspaceIdentity: "controlled-workflow" } },
    shuttingDown: false,
    hasActiveOrQueuedTurnWork: () => false,
    createWorkflowAdmission,
    sessionId: "controlled-workflow-session",
    rootTraceContext: { traceId: "controlled-workflow-trace", spanId: "controlled-workflow-span" },
    permissionService: new PermissionService(defaultPermissionConfig, {
      authorize: async () => {
        admissions++;
        return { allowed: false, code: "enterprise_filesystem_denied" };
      },
    }),
  } as unknown as ThisParameterType<typeof startSavedWorkflowRun>;
  await assert.rejects(
    startSavedWorkflowRun.call(runtime, { name: "does-not-exist", scope: "project" }),
    /enterprise_filesystem_denied/,
  );
  assert.equal(admissions, 1);
});

test("direct workflow start rechecks its original owner after asynchronous context initialization before draft IO", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "uwork-workflow-context-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  saveSavedWorkflow({
    cwd,
    name: "controlled",
    meta: { description: "controlled" },
    script: "return 1;",
  });
  let allowed = true,
    persisted = 0,
    submissions = 0;
  const runtime = {
    workingDirectory: cwd,
    workspaceRoot: cwd,
    config: {},
    shuttingDown: false,
    sessionId: "controlled",
    rootTraceContext: context.traceContext,
    hasActiveOrQueuedTurnWork: () => false,
    createWorkflowAdmission,
    permissionService: new PermissionService(defaultPermissionConfig, {
      authorize: async () =>
        allowed
          ? { allowed: true, code: "allowed", ownerKey: ownerA }
          : { allowed: false, code: "enterprise_filesystem_denied" },
    }),
    ensureContextInitialized: async () => {
      await Promise.resolve();
      allowed = false;
    },
    ensureSessionPersisted: async () => {
      persisted++;
    },
    dynamicWorkflowRunPort: {
      submit: async () => {
        submissions++;
        return { ok: true, runId: "forbidden" };
      },
    },
  } as unknown as ThisParameterType<typeof startSavedWorkflowRun>;
  await assert.rejects(
    startSavedWorkflowRun.call(runtime, { name: "controlled", scope: "project" }),
    /enterprise_filesystem_denied/,
  );
  assert.equal(persisted, 0);
  assert.equal(submissions, 0);
  await assert.rejects(readdir(join(cwd, ".zcode", "workflow-drafts")), { code: "ENOENT" });
});

test("best-effort workflow draft IO never swallows an operation permission failure", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "uwork-workflow-draft-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let checks = 0;
  await assert.rejects(
    writeWorkflowDraft({
      cwd,
      name: "controlled",
      source: "PRIVATE_CONTROLLED_SCRIPT",
      admission: {
        revalidate: async () => {
          if (++checks === 3) throw new Error("enterprise_filesystem_denied");
        },
      },
    }),
    /enterprise_filesystem_denied/,
  );
  assert.deepEqual(await readdir(join(cwd, ".zcode", "workflow-drafts")), [".gitignore"]);
});
