import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  InMemorySessionEventStore,
  createSessionId,
  type EnterpriseToolAuthorizationPort,
  type EnterpriseToolAuthorizationRequest,
  type Model,
} from "@zcode/contracts";
import { NodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";

export const DESCRIPTION = "OWNED_TOPIC_DESCRIPTION_NOT_IN_USER_PROMPT_20261021";
export const PROMPT = "remember owned preference";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function manifestFixture(
  t: TestContext,
  unmanaged: "absent" | "explicit" | false = false,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uwork-manifest-policy-")));
  const workspace = join(root, "workspace"),
    cliStorageRoot = join(root, "cli");
  const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: workspace });
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(memoryRoot, { recursive: true, mode: 0o700 });
  const topic = join(memoryRoot, "owned-topic.md");
  const otherOwnedCwd = join(root, "later-main-cwd");
  await mkdir(otherOwnedCwd, { mode: 0o700 });
  await writeFile(
    topic,
    `---\nname: owned-topic\ndescription: ${DESCRIPTION}\nmetadata:\n  type: project\n---\nOwned local test topic.\n`,
    { mode: 0o600 },
  );
  const state = {
    allowed: true,
    managed: unmanaged !== "explicit",
    ownerKey: "a".repeat(64) as string | undefined,
    listings: 0,
    topicReads: 0,
    holdRead: false,
  };
  const entered = deferred(),
    release = deferred(),
    returned = deferred();
  const admissions: EnterpriseToolAuthorizationRequest[] = [];
  const authorization: EnterpriseToolAuthorizationPort = {
    async authorize(request) {
      admissions.push(structuredClone(request));
      const memory =
        request.toolName === "ProjectMemoryIndexRead" ||
        request.toolName === "ProjectMemoryManifestRead";
      return {
        allowed: !memory || state.allowed,
        code:
          memory && !state.allowed
            ? "enterprise_filesystem_denied"
            : state.managed
              ? "allowed"
              : "not_managed",
        ...(state.managed ? { ownerKey: state.ownerKey } : {}),
      };
    },
  };
  const permissionService = new PermissionService(
    defaultPermissionConfig,
    unmanaged === "absent" ? undefined : authorization,
  );
  const fileSystem = new NodeFileSystemAdapter();
  const list = fileSystem.listDirectory.bind(fileSystem),
    range = fileSystem.readTextFileRange.bind(fileSystem);
  fileSystem.listDirectory = async (request, options) => {
    assert.equal(request.path, memoryRoot);
    state.listings++;
    return list(request, options);
  };
  fileSystem.readTextFileRange = async (request, options) => {
    assert.equal(request.path, topic);
    assert.equal(request.offsetLine, 0);
    assert.equal(request.limitLines, 30);
    state.topicReads++;
    const value = await range(request, options);
    entered.resolve();
    if (state.holdRead) await release.promise; // Only a test barrier after real owned bytes, deliberately ignores late cancellation.
    returned.resolve();
    return value;
  };
  const store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
  const requests: Parameters<Model["generateText"]>[0][] = [];
  const model: Model = {
    providerId: "controlled" as Model["providerId"],
    modelId: "controlled" as Model["modelId"],
    displayName: "controlled",
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: false,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    },
    optionSpecs: {
      reasoningLevel: { values: ["none"], map: "return {}" },
      maxOutputTokens: { max: 100, map: "return {}" },
    },
    options: {},
    bind: () => model,
    async generateText(request) {
      requests.push(structuredClone({ ...request, abortSignal: undefined }));
      return {
        text: "Nothing to save.",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    streamText() {
      throw Error("Controlled nonstream branch only");
    },
  };
  const id = createSessionId("controlled-manifest-policy");
  const runtime = new AgentRuntime(
    id,
    {
      workingDirectory: workspace,
      modelSelection: { providerId: "controlled", modelId: "controlled" },
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      memory: { enabled: true, use: true, cliStorageRoot, extractionEnabled: true },
    },
    {
      eventStore: new InMemorySessionEventStore(),
      permissionService,
      fileSystemPort: fileSystem,
      sessionStore: store,
      modelFactory: () => model,
      contextSourcePort: {
        async resolveContextSources() {
          return {
            workingDirectory: workspace,
            currentDate: "2026-10-21",
            envInfo: { cwd: workspace, platform: "unknown" },
          };
        },
      } as unknown as NonNullable<
        import("../src/runtime/types.js").AgentRuntimeDeps["contextSourcePort"]
      >,
    },
  );
  const internal = runtime as unknown as AgentRuntimeInternal;
  t.after(async () => {
    release.resolve();
    runtime.beginShutdown();
    await runtime.drainMemoryExtractions(null);
    await runtime.closeBrowserSession();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const setPort = (port?: EnterpriseToolAuthorizationPort) =>
    Object.defineProperty(permissionService, "enterpriseAuthorization", {
      configurable: true,
      value: port,
    });
  return {
    root,
    workspace,
    memoryRoot,
    topic,
    otherOwnedCwd,
    newFileSystem: () => new NodeFileSystemAdapter(),
    runtime,
    internal,
    id,
    store,
    state,
    entered,
    release,
    returned,
    requests,
    admissions,
    authorization,
    setPort,
    sidecars: () =>
      requests.filter((q) =>
        JSON.stringify(q.messages).includes(
          "You are now acting as the memory extraction subagent.",
        ),
      ),
    turn: () => runtime.executeTurn(PROMPT),
    drain: () => runtime.drainMemoryExtractions(null),
  };
}
