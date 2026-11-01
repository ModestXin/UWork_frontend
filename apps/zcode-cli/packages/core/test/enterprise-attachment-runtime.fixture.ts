import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  InMemorySessionEventStore,
  createSessionId,
  type EnterpriseToolAuthorizationPort,
  type EnterpriseToolAuthorizationRequest,
  type FileSystemPort,
  type Model,
  type ToolArtifactStorePort,
} from "@zcode/contracts";
import type { TurnAttachment } from "../src/runtime/deps.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentRuntimeDeps } from "../src/runtime/types.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export type LocalKind = "file" | "image" | "video" | "pdf";
type ModelRequest = Parameters<Model["generateText"]>[0];
export const KINDS: LocalKind[] = ["file", "image", "video", "pdf"];
const selection = { providerId: "controlled", modelId: "controlled" };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

export function fixture(t: TestContext, storage: Pick<AgentRuntimeDeps, "sessionStore"> = {}) {
  const state = {
    allowed: true,
    managed: true,
    ownerKey: "a".repeat(64) as string | undefined,
    unavailable: false,
    reads: 0,
    stats: 0,
    imageCalls: 0,
  };
  const admissions: EnterpriseToolAuthorizationRequest[] = [];
  const authorityEntered = deferred();
  const authorityRelease = deferred();
  const authorization: EnterpriseToolAuthorizationPort = {
    async authorize(request) {
      admissions.push(structuredClone(request));
      if (controls.holdAuthorizationPhase === request.phase) {
        authorityEntered.resolve();
        await authorityRelease.promise;
      }
      if (state.unavailable) throw Error("controlled authority unavailable");
      return {
        allowed: state.allowed,
        code: state.allowed
          ? state.managed
            ? "allowed"
            : "not_managed"
          : "enterprise_filesystem_denied",
        ...(state.managed ? { ownerKey: state.ownerKey } : {}),
      };
    },
  };
  const permissionService = new PermissionService(defaultPermissionConfig, authorization);
  const bodies = new Map<string, Buffer>();
  const writes: string[] = [];
  const requests: ModelRequest[] = [];
  const readEntered = deferred();
  const readRelease = deferred();
  const readReturned = deferred();
  const readBlocked = deferred();
  const imageEntered = deferred();
  const imageRelease = deferred();
  const controls = {
    holdRead: false,
    holdReadPath: undefined as string | undefined,
    holdImage: false,
    holdAuthorizationPhase: undefined as "before_dispatch" | "before_result" | undefined,
    onModel: undefined as ((index: number) => Promise<void>) | undefined,
  };
  const body = (path: string) => {
    const value = bodies.get(path);
    assert.ok(value, "only explicitly supplied synthetic files may be read");
    return value;
  };
  const read = async (path: string) => {
    state.reads++;
    readEntered.resolve();
    if (controls.holdRead && (!controls.holdReadPath || controls.holdReadPath === path)) {
      readBlocked.resolve();
      await readRelease.promise;
    }
    readReturned.resolve();
    return body(path);
  };
  const fileSystemPort = {
    async stat(request: { path: string }) {
      state.stats++;
      return { path: request.path, kind: "file", sizeBytes: body(request.path).length, mtimeMs: 1 };
    },
    async readTextFileRange(request: { path: string }) {
      const bytes = await read(request.path);
      return {
        path: request.path,
        content: bytes.toString(),
        encoding: "utf8",
        bytesRead: bytes.length,
        sizeBytes: bytes.length,
        truncated: false,
        startLine: 1,
        lineCount: 1,
        totalLines: 1,
      };
    },
    async readTextFile(request: { path: string; encoding?: string }) {
      const bytes = await read(request.path);
      return {
        path: request.path,
        content: bytes.toString(request.encoding === "base64" ? "base64" : "utf8"),
        encoding: request.encoding ?? "utf8",
        bytesRead: bytes.length,
        sizeBytes: bytes.length,
        truncated: false,
      };
    },
    async readBinaryFile(request: { path: string }) {
      const bytes = await read(request.path);
      return {
        path: request.path,
        content: bytes,
        bytesRead: bytes.length,
        sizeBytes: bytes.length,
        truncated: false,
      };
    },
  } as unknown as FileSystemPort;
  const artifactStore = {
    async writeToolResultArtifact(request: { content: string }) {
      writes.push(request.content);
      return { uri: `zcode-artifact://controlled/${writes.length}` };
    },
  } as unknown as ToolArtifactStorePort;
  const model: Model = {
    providerId: "controlled" as Model["providerId"],
    modelId: "controlled" as Model["modelId"],
    displayName: "controlled",
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
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
      await controls.onModel?.(requests.length - 1);
      return { text: "controlled answer", finishReason: "stop", usage };
    },
    streamText() {
      throw Error("fixture must use original non-streaming branch");
    },
  };
  const runtime = new AgentRuntime(
    createSessionId("controlled-attachment"),
    {
      modelSelection: selection,
      modelStreaming: "off",
      workingDirectory: join(process.env.HOME!, "workspace"),
      memory: { enabled: false },
      titleGeneration: { enabled: false },
      systemPrompt: "controlled context",
    },
    {
      eventStore: new InMemorySessionEventStore(),
      ...storage,
      permissionService,
      fileSystemPort,
      artifactStore,
      modelFactory: () => model,
      imageProcessorPort: {
        async resizeToFit() {
          throw Error("fixture uses the prepareForModel port");
        },
        async prepareForModel(request) {
          state.imageCalls++;
          imageEntered.resolve();
          if (controls.holdImage) await imageRelease.promise;
          return {
            data: request.data,
            mediaType: request.mediaType,
            width: 1,
            height: 1,
            originalWidth: 1,
            originalHeight: 1,
            resized: false,
            compressed: false,
            originalSizeBytes: request.data.length,
            strategy: "original",
            transformedSizeBytes: request.data.length,
          };
        },
      },
    },
  );
  t.after(async () => {
    authorityRelease.resolve();
    readRelease.resolve();
    imageRelease.resolve();
    await runtime.closeBrowserSession();
  });
  const attachment = (kind: LocalKind, label = "B"): TurnAttachment => {
    const ext = { file: "txt", image: "png", video: "mp4", pdf: "pdf" }[kind];
    const path = join(process.env.HOME!, "workspace", `${label}.${ext}`);
    const marker = `NEW_ATTACHMENT_BODY_${label}_${kind}`;
    bodies.set(path, Buffer.from(kind === "pdf" ? `%PDF-1.7\n${marker}\n%%EOF` : marker));
    return { type: kind, path };
  };
  const marker = (kind: LocalKind, label = "B") =>
    kind === "file"
      ? `NEW_ATTACHMENT_BODY_${label}_${kind}`
      : body(attachment(kind, label).path!).toString("base64");
  return {
    state,
    admissions,
    authorization,
    permissionService,
    runtime,
    requests,
    writes,
    controls,
    bodies,
    attachment,
    marker,
    readEntered,
    readRelease,
    readReturned,
    readBlocked,
    imageEntered,
    imageRelease,
    authorityEntered,
    authorityRelease,
    setPort: (value: EnterpriseToolAuthorizationPort | undefined) => {
      Object.defineProperty(permissionService, "enterpriseAuthorization", {
        configurable: true,
        value,
        writable: true,
      });
    },
    history: () =>
      JSON.stringify(
        (runtime as unknown as AgentRuntimeInternal).messageHistory.borrowReadOnlyRuntimeEntries(),
      ),
    modelText: () => JSON.stringify(requests),
  };
}
