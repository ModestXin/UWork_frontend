import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import {
  createCoreError,
  createRootTraceContext,
  CoreErrorType,
  type ExecutionPort,
  type SessionId,
  type ToolArtifactStorePort,
} from "@zcode/contracts";
import { executeWorldRead } from "../src/app/workflow-world-read.js";
import { executeArtifactPublish } from "../src/app/workflow-artifact-publish.js";
import { createDynamicWorkflowRunService } from "../src/app/dynamic-workflow-run-service.js";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";

test("world read withholds actual file bytes after its run owner changes during IO", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "uwork-world-fence-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "controlled.txt"), "CONTROLLED_PRIVATE_WORLD_BODY");
  const real = createNodeFileSystemAdapter();
  let allowed = true,
    reads = 0;
  const originalReadText = real.readTextFile.bind(real);
  const fileSystemPort = Object.assign(real, {
    readTextFile: async (...args: Parameters<typeof real.readTextFile>) => {
      const result = await originalReadText(...args);
      reads++;
      allowed = false;
      return result;
    },
  });
  const admission = {
    revalidate: async () => {
      if (!allowed)
        throw createCoreError(CoreErrorType.PermissionDenied, "enterprise_identity_changed", {
          context: { source: "enterprise-policy" },
        });
    },
  };
  await assert.rejects(
    executeWorldRead(
      { cwd, fileSystemPort, executionPort: {} as ExecutionPort, admission },
      "read",
      ["controlled.txt"],
    ),
    /enterprise_identity_changed/,
  );
  assert.equal(reads, 1);
});

test("artifact file read rechecks current permission before publishing any bytes to its store", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "uwork-artifact-fence-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "controlled.txt"), "CONTROLLED_PRIVATE_ARTIFACT_BODY");
  const real = createNodeFileSystemAdapter();
  let allowed = true,
    writes = 0;
  const originalReadBinary = real.readBinaryFile.bind(real);
  const fileSystemPort = Object.assign(real, {
    readBinaryFile: async (...args: Parameters<typeof real.readBinaryFile>) => {
      const result = await originalReadBinary(...args);
      allowed = false;
      return result;
    },
  });
  const admission = {
    revalidate: async () => {
      if (!allowed)
        throw createCoreError(CoreErrorType.PermissionDenied, "enterprise_filesystem_denied", {
          context: { source: "enterprise-policy" },
        });
    },
  };
  const artifactStore = {
    writeToolResultArtifact: async () => {
      writes++;
      throw new Error("must not publish");
    },
    writeToolResultBinaryArtifact: async () => {
      writes++;
      throw new Error("must not publish");
    },
  } as unknown as ToolArtifactStorePort;
  await assert.rejects(
    executeArtifactPublish(
      { cwd, fileSystemPort, artifactStore, parentSessionId: "controlled" as SessionId, admission },
      {
        id: "controlled",
        version: 1,
        op: "file",
        path: "controlled.txt",
        runId: "controlled",
        siteId: "artifact#1",
        ordinal: 1,
      },
    ),
    /enterprise_filesystem_denied/,
  );
  assert.equal(writes, 0);
});

test("service close rejects an uncooperative pending entry admission before registration", async () => {
  let release!: () => void, reached!: () => void;
  const entered = new Promise<void>((done) => {
    reached = done;
  });
  const journal = new InMemoryJournalStore();
  const service = createDynamicWorkflowRunService({
    journal,
    parentSessionId: "controlled",
    fileSystemPort: createNodeFileSystemAdapter(),
    executionPort: {} as ExecutionPort,
    createActorRuntime: () => {
      throw new Error("must not construct actor");
    },
    createExecutionAdmission: () => {
      reached();
      return new Promise((done) => {
        release = () => done({ revalidate: async () => {} });
      });
    },
  });
  const pending = service.submit({
    scriptText: "return 1;",
    cwd: tmpdir(),
    trace: createRootTraceContext(),
  });
  await entered;
  await service.close();
  await assert.rejects(
    pending,
    (error) => String(error).includes("interrupted") || String(error).includes("closed"),
  );
  release();
  assert.equal(service.countLiveRuns(), 0);
});
