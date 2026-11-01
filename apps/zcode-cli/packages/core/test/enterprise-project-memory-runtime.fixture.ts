import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import {
  InMemorySessionEventStore,
  createSessionId,
  type EnterpriseToolAuthorizationPort,
  type EnterpriseToolAuthorizationRequest,
  type FileSystemPort,
  type Model,
  type SkillPort,
  type SkillMetadata,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";

export const MARKER = "FRESH_PROJECT_MEMORY_NOT_PREVIOUSLY_CONSUMED";
const OWNER = "a".repeat(64);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function fixture(t: TestContext, unmanaged: "absent" | "explicit" | false = false) {
  const workspace = join(tmpdir(), "owned-memory-contract", "workspace");
  const cliStorageRoot = join(tmpdir(), "owned-memory-contract", "cli");
  const index = join(
    resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: workspace }),
    "MEMORY.md",
  );
  const state = {
    allowed: true,
    managed: unmanaged !== "explicit",
    ownerKey: OWNER as string | undefined,
    reads: 0,
    readMode: "body" as "body" | "missing" | "empty" | "unreadable",
    dispatchCode: undefined as string | undefined,
    skills: [] as SkillMetadata[],
    directories: 0,
  };
  const controls = {
    holdRead: false,
    holdSkills: false,
    holdRoot: false,
    holdContext: false,
    holdAuthority: false,
  };
  const entered = {
    read: deferred(),
    skills: deferred(),
    root: deferred(),
    context: deferred(),
    authority: deferred(),
  };
  const release = {
    read: deferred(),
    skills: deferred(),
    root: deferred(),
    context: deferred(),
    authority: deferred(),
  };
  const admissions: EnterpriseToolAuthorizationRequest[] = [];
  const authorization: EnterpriseToolAuthorizationPort = {
    async authorize(request) {
      if (request.toolName === "ProjectMemoryIndexRead") admissions.push(structuredClone(request));
      if (request.toolName === "ProjectMemoryIndexRead" && request.phase === "before_result") {
        entered.authority.resolve();
        if (controls.holdAuthority) await release.authority.promise;
      }
      if (
        request.toolName === "ProjectMemoryIndexRead" &&
        request.phase === "before_dispatch" &&
        state.dispatchCode
      )
        return { allowed: false, code: state.dispatchCode };
      return {
        allowed: request.toolName !== "ProjectMemoryIndexRead" || state.allowed,
        code:
          request.toolName === "ProjectMemoryIndexRead" && !state.allowed
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
        text: "controlled answer",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    streamText() {
      throw Error("Original non-streaming test branch required");
    },
  };
  const fileSystemPort = {
    async createDirectory() {
      state.directories++;
      entered.root.resolve();
      if (controls.holdRoot) await release.root.promise;
    },
    async readTextFile(request: { path: string }) {
      assert.equal(request.path, index);
      state.reads++;
      entered.read.resolve();
      if (controls.holdRead) await release.read.promise;
      if (state.readMode === "missing" || state.readMode === "unreadable")
        throw Object.assign(Error("Controlled index read failed"), {
          code: state.readMode === "missing" ? "ENOENT" : "EACCES",
        });
      const content = state.readMode === "empty" ? "  \n" : MARKER;
      return {
        path: index,
        content,
        encoding: "utf8",
        bytesRead: content.length,
        sizeBytes: content.length,
        truncated: false,
      };
    },
  } as unknown as FileSystemPort;
  const skillPort: SkillPort = {
    enterpriseAssetGuarded: true,
    async discoverSkills() {
      entered.skills.resolve();
      if (controls.holdSkills) await release.skills.promise;
      return { skills: state.skills, diagnostics: [], totalDiscovered: state.skills.length };
    },
    async loadSkill() {
      throw Error("No Skill body requested by this Memory context test");
    },
  };
  const runtime = new AgentRuntime(
    createSessionId("controlled-project-memory"),
    {
      workingDirectory: workspace,
      modelSelection: { providerId: "controlled", modelId: "controlled" },
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      memory: { enabled: true, use: true, cliStorageRoot },
    },
    {
      eventStore: new InMemorySessionEventStore(),
      permissionService,
      fileSystemPort,
      skillPort,
      modelFactory: () => model,
      contextSourcePort: {
        async resolveContextSources() {
          entered.context.resolve();
          if (controls.holdContext) await release.context.promise;
          return {
            workingDirectory: workspace,
            currentDate: "2026-10-21",
            envInfo: { platform: "unknown" },
            userInstructions: undefined,
            projectContext: undefined,
          };
        },
      } as unknown as NonNullable<
        import("../src/runtime/types.js").AgentRuntimeDeps["contextSourcePort"]
      >,
    },
  );
  const internal = runtime as unknown as AgentRuntimeInternal;
  const pending: Promise<unknown>[] = [];
  const turn = (signal?: AbortSignal) => {
    const value = runtime.executeTurn("PLAIN", undefined, { abortSignal: signal });
    pending.push(value);
    return value;
  };
  t.after(async () => {
    for (const gate of Object.values(release)) gate.resolve();
    await Promise.allSettled(pending);
    await runtime.closeBrowserSession();
  });
  const snapshot = () =>
    JSON.stringify({
      memory: internal.memoryIndexContent,
      reads: [...internal.readFileState],
      history: internal.messageHistory.borrowReadOnlyRuntimeEntries(),
    });
  const setPort = (port?: EnterpriseToolAuthorizationPort) =>
    Object.defineProperty(permissionService, "enterpriseAuthorization", {
      configurable: true,
      value: port,
    });
  return {
    runtime,
    internal,
    state,
    controls,
    entered,
    release,
    requests,
    admissions,
    authorization,
    turn,
    snapshot,
    setPort,
    pending,
    skillPort,
  };
}
