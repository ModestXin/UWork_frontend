import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createInMemorySessionEventStore,
  ModelErrorCode,
  ModelProtocolError,
  type Logger,
  type SessionStorePort,
} from "@zcode/contracts";
import { InMemoryWorkspaceHookPolicyProvider } from "../src/index.js";
import { zcodeSessionStateSnapshotSchema, type ModelSelection } from "@zcode/shared";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
  ProviderRegistry,
} from "../../../../../packages/provider/src/index.js";
import { createZCodeApp } from "../../bootstrap/src/app/create-app.js";
import type { ZCodeApp } from "../../bootstrap/src/app/types.js";
import { createSession } from "../../bootstrap/src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../../bootstrap/src/zcode-protocol/server-types.js";
import { V4InteractionRegistry } from "../../bootstrap/src/zcode-protocol-v4/interaction-registry.js";

const INITIAL_SELECTION: ModelSelection = Object.freeze({
  providerId: "controlled",
  modelId: "session-model",
  options: Object.freeze({ reasoningLevel: "high" }),
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(os.tmpdir(), "uwork-legacy-create-contract-"));
  // Snapshot 的命令目录发现也使用 OS home；仅替换此 IO 边界，不能读取测试者个人目录。
  const home = t.mock.method(os, "homedir", () => directory);
  syncBuiltinESMExports();
  const apps: ZCodeApp[] = [];
  let context: ZCodeProtocolAgentServerContext | undefined;
  let modelRequests = 0;
  t.after(async () => {
    try {
      for (const record of context?.sessions.values() ?? []) record.unsubscribe?.();
      for (const app of apps) await app.close?.();
      await rm(directory, { recursive: true, force: true });
      assert.equal(modelRequests, 0);
    } finally {
      home.mock.restore();
      syncBuiltinESMExports();
    }
  });
  await mkdir(join(directory, ".git"));
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      features: { memory: false, mcp: false, subagent: false },
      plugins: { enabled: false },
      skills: { enabled: false },
    }),
  );
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "enterprise-session" },
      api: { type: "openai-chat-completions", baseUrl: "https://model.example.test/v1" },
    }),
  );
  const model = createRegistryModelConfig(
    parseModelConfig({
      enabled: true,
      properties: {
        contextWindow: 128000,
        requiresMfjsToolSchema: false,
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
        supportsMidConversationSystem: false,
      },
      optionSpecs: {
        reasoningLevel: { values: ["low", "high"], map: "{}" },
        maxOutputTokens: { max: 16, map: '{"max_tokens":maxOutputTokens}' },
      },
    }),
  );
  assert.ok(provider.ok && model.ok);
  const registry = new ProviderRegistry([
    {
      providerId: INITIAL_SELECTION.providerId,
      config: provider.config,
      models: [{ modelId: INITIAL_SELECTION.modelId, config: model.config }],
    },
  ]);
  const entries: { data: unknown; type: string }[] = [];
  const sessionStore = {
    getSession: async () => null,
    messages: async () => [],
    readTodos: async () => [],
    readTarget: async () => null,
    sessionEntries: async ({ type }: { type: string }) => entries.filter((e) => e.type === type),
    saveSessionEntry: async (entry: { data: unknown; type: string }) => {
      entries.push(structuredClone(entry));
    },
  } as unknown as SessionStorePort;
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => logger,
  };
  const env = {
    HOME: directory,
    USERPROFILE: directory,
    ZCODE_STORAGE_DIR: join(directory, "storage"),
    ZCODE_ENV: "test",
    ZCODE_MODEL_TELEMETRY_ENABLED: "false",
  };
  context = {
    deps: {
      env,
      sessionStore,
      createSessionEventStore: () => createInMemorySessionEventStore(),
      workspaceHookPolicyProvider: new InMemoryWorkspaceHookPolicyProvider(),
      createZCodeApp: async (options) => {
        const app = await createZCodeApp({
          ...options,
          env,
          providerRegistry: registry,
          officialPluginRoots: [],
          skipUserConfig: true,
          projectConfigPath: configPath,
          loggerFactory: { createLogger: () => logger, withContext: () => logger, setLevel() {} },
          enterpriseModelRelay: {
            request: async () => {
              modelRequests++;
              throw new Error("Unexpected model request during session creation");
            },
          },
        });
        apps.push(app);
        return app;
      },
    },
    sessions: new Map(),
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
    },
    v4Interactions: new V4InteractionRegistry(),
    notify() {},
    requestClient: async (_method, _params, schema) =>
      schema.parse({
        askUserQuestionAutoResolutionEnabled: false,
        memoryEnabled: false,
        nativeSearchEnhancementsEnabled: true,
      }),
  } satisfies Partial<ZCodeProtocolAgentServerContext> as ZCodeProtocolAgentServerContext;
  return {
    context,
    entries,
    create: (model: ModelSelection = INITIAL_SELECTION, thoughtLevel?: string) =>
      createSession(context, {
        workspace: { workspacePath: directory, workspaceKey: directory },
        model,
        ...(thoughtLevel ? { thoughtLevel } : {}),
      }).then((snapshot) => zcodeSessionStateSnapshotSchema.parse(snapshot)),
  };
}

for (const [thoughtLevel, expected] of [
  [undefined, "high"],
  ["low", "low"],
  ["unsupported", "high"],
] as const) {
  test(`legacy create keeps complete model options with independent thoughtLevel=${thoughtLevel}`, async (t) => {
    const f = await fixture(t);
    const snapshot = await f.create(INITIAL_SELECTION, thoughtLevel);
    const expectedSelection = { ...INITIAL_SELECTION, options: { reasoningLevel: expected } };
    assert.deepEqual(snapshot.settings.model.current, expectedSelection);
    assert.equal(snapshot.settings.thoughtLevel.current, expected);
    assert.deepEqual(f.entries.at(-1)?.data, expectedSelection);
    assert.deepEqual(
      f.context.sessions.get(snapshot.session.sessionId)?.app.runtime.getSessionModelSelection(),
      expectedSelection,
    );
    assert.equal(INITIAL_SELECTION.options?.reasoningLevel, "high");
  });
}

for (const options of [undefined, { reasoningLevel: "unsupported" }]) {
  test(`legacy create still rejects ${options ? "invalid" : "missing"} model reasoning`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.create({ ...INITIAL_SELECTION, options }),
      (error: unknown) =>
        error instanceof ModelProtocolError && error.code === ModelErrorCode.InvalidModelRequest,
    );
    assert.equal(f.context.sessions.size, 0);
    assert.equal(f.entries.length, 0);
  });
}
