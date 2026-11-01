import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderRuntime } from "../../../../../packages/services/src/model-provider/providerRuntime.js";
import { providerSettingsTrustedGatewayProvisioning } from "../../../../../packages/services/src/model-provider/providerFacadeServices.js";

async function fixture(t: TestContext, legacyDefault = false) {
  const directory = await mkdtemp(join(tmpdir(), "uwork-managed-catalog-"));
  const path = join(directory, "personal.json");
  const options = {
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: path,
    personalPollingIntervalMs: false as const,
    watch: false,
  };
  let runtime = createProviderRuntime(options);
  t.after(async () => {
    runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  if (legacyDefault) {
    // 仅fixture初始化：通过同一Node Repository保存旧偏好，关闭后再启动真正runtime owner。
    const { NodePersonalProviderConfigRepository, NodeModelSelectionConfigRepository } =
      await import("../../../../../packages/provider-node/src/index.js");
    const repository = new NodePersonalProviderConfigRepository({
      filePath: path,
      pollingIntervalMs: false,
    });
    const defaults = new NodeModelSelectionConfigRepository({ personalRepository: repository });
    try {
      await defaults.saveConfiguredDefault({
        providerId: "ucas",
        modelId: "ucas-deepseek-flash",
        options: { reasoningLevel: "max" },
      });
    } finally {
      defaults.dispose();
      repository.dispose();
    }
  }
  await runtime.start();
  const apply = async (ids: readonly string[]) =>
    runtime.providerSettings[providerSettingsTrustedGatewayProvisioning]({
      baseUrl: "https://backend.example.test/v1",
      authMode: "enterprise-session",
      modelIds: ids,
      managedModels: ids.map((id) => ({
        id,
        contextWindow: 128000,
        maxOutputTokens: 16,
        supportsVision: false,
        supportsReasoning: false,
        supportsTools: false,
      })),
    });
  return {
    path,
    get runtime() {
      return runtime;
    },
    apply,
    raw: () => readFile(path, "utf8"),
    restart: async () => {
      runtime.dispose();
      runtime = createProviderRuntime(options);
      await runtime.start();
    },
  };
}

test("fresh managed catalog is the only UCAS executable candidate and default", async (t) => {
  const f = await fixture(t);
  await f.apply(["opaque-allowed"]);
  const provider = f.runtime.registryService.getProvider("ucas");
  assert.ok(provider);
  assert.deepEqual(
    provider.models.map((m) => m.modelId),
    ["opaque-allowed"],
  );
  const view = await f.runtime.modelSelection.getView();
  assert.deepEqual(view.preferredSelection, {
    providerId: "ucas",
    modelId: "opaque-allowed",
    options: { reasoningLevel: "none" },
  });
  assert.equal(
    f.runtime.registryService.validateSelection({
      providerId: "ucas",
      modelId: "ucas-deepseek-flash",
      options: { reasoningLevel: "max" },
    }).ok,
    false,
  );
});

test("managed directory shrink and empty refresh remove old executable candidates", async (t) => {
  const f = await fixture(t);
  await f.apply(["opaque-old", "opaque-retained"]);
  await f.apply(["opaque-retained"]);
  assert.deepEqual(
    f.runtime.registryService.getProvider("ucas")?.models.map((m) => m.modelId),
    ["opaque-retained"],
  );
  await f.apply([]);
  assert.equal(f.runtime.registryService.getProvider("ucas"), undefined);
  assert.equal((await f.runtime.modelSelection.getView()).preferredSelection, undefined);
});

test("catalog survives disk restart and model disabled preference still wins", async (t) => {
  const f = await fixture(t);
  await f.apply(["opaque-allowed"]);
  await f.runtime.providerSettings.setPersonalModelEnabled("ucas", "opaque-allowed", false);
  await f.apply(["opaque-allowed"]);
  assert.equal(f.runtime.registryService.getProvider("ucas"), undefined);
  const configured = (await f.runtime.providerSettings.getView()).providers.find(
    (p) => p.providerId === "ucas",
  )!.models;
  assert.ok(configured.some((m) => m.modelId === "ucas-deepseek-flash"));
  assert.equal(configured.find((m) => m.modelId === "opaque-allowed")!.enabled, false);
  await f.restart();
  assert.equal(f.runtime.registryService.getProvider("ucas"), undefined);
  await f.runtime.providerSettings.setPersonalModelEnabled("ucas", "opaque-allowed", true);
  assert.deepEqual(
    f.runtime.registryService.getProvider("ucas")!.models.map((m) => m.modelId),
    ["opaque-allowed"],
  );
  assert.equal(
    (await f.runtime.modelSelection.getView()).preferredSelection!.options!.reasoningLevel,
    "none",
  );
});

test("unmanaged and legacy API-key sentinels keep their configuration when enterprise candidate projection changes", async (t) => {
  const f = await fixture(t);
  await f.runtime.providerSettings.applyUcasGatewayProvisioning({
    baseUrl: "https://legacy.example.test/v1",
    apiKey: "synthetic-legacy-key",
    replaceApiKey: true,
  });
  const other = await f.runtime.providerSettings.createPersonalProvider({
    providerName: "Other",
    initialConfig: {
      api: { type: "openai-chat-completions", baseUrl: "https://personal.example.test/v1" },
      access: { type: "api-key", apiKey: "synthetic-personal-key" },
    },
  });
  await f.runtime.providerSettings.addPersonalModel(
    other.providerId,
    "personal-sentinel",
    {},
    true,
  );
  const sentinel = JSON.stringify(f.runtime.registryService.getProvider(other.providerId));
  const legacyBefore = (await f.runtime.providerSettings.getView()).providers.find(
    (p) => p.providerId === "ucas",
  )!;
  const legacyRules = legacyBefore.models.map((m) => ({
    id: m.modelId,
    config: m.personalExactConfig,
    enabled: m.enabled,
  }));
  await f.apply(["opaque-one"]);
  await f.apply([]);
  assert.equal(JSON.stringify(f.runtime.registryService.getProvider(other.providerId)), sentinel);
  const after = (await f.runtime.providerSettings.getView()).providers.find(
    (p) => p.providerId === "ucas",
  )!;
  assert.deepEqual(
    after.models
      .filter((m) => m.modelId !== "opaque-one")
      .map((m) => ({ id: m.modelId, config: m.personalExactConfig, enabled: m.enabled })),
    legacyRules,
  );
  assert.equal(
    (await f.runtime.modelSelection.getView()).preferredSelection!.providerId,
    other.providerId,
  );
  await f.runtime.providerSettings.applyUcasGatewayProvisioning({
    baseUrl: "https://legacy.example.test/v1",
    apiKey: "synthetic-legacy-key",
    replaceApiKey: true,
  });
  assert.ok(
    f.runtime.registryService
      .getProvider("ucas")!
      .models.some((m) => m.modelId === "ucas-deepseek-flash"),
  );
  assert.equal(JSON.stringify(f.runtime.registryService.getProvider(other.providerId)), sentinel);
});

test("obsolete owner callback is checked after acquiring the actual Repository write lock", async (t) => {
  const f = await fixture(t);
  await f.apply(["opaque-current"]);
  const before = await f.raw();
  let admitted = true;
  // 同一Facade事务锁内执行：旧401清理排队后失效，不得清掉当前快照。
  const { withFileLock } = await import("../../../../../packages/shared/src/node.js");
  // Repository路径由fixture独占，下面只做显式队列/owner失效注入，不改业务数据。
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const released = new Promise<void>((done) => {
    release = done;
  });
  const held = withFileLock(f.path, async () => {
    enter();
    await released;
  });
  await entered;
  const late = f.runtime.configService.applyUcasGatewayConfig({
    baseUrl: "https://backend.example.test/v1",
    authMode: "enterprise-session",
    enterpriseModelIds: [],
    isCurrent: () => admitted,
  });
  admitted = false;
  release();
  await held;
  await assert.rejects(late, /enterprise_identity_changed/);
  assert.equal(await f.raw(), before);
  assert.deepEqual(
    f.runtime.registryService.getProvider("ucas")!.models.map((m) => m.modelId),
    ["opaque-current"],
  );
});

test("invalid legacy default falls back only for new drafts while original disk preference is retained", async (t) => {
  const f = await fixture(t, true);
  const stored = JSON.parse(await f.raw()).config.defaultModelSelection;
  await f.apply(["opaque-permitted"]);
  assert.equal(
    (await f.runtime.modelSelection.getView()).preferredSelection!.modelId,
    "opaque-permitted",
  );
  assert.deepEqual(JSON.parse(await f.raw()).config.defaultModelSelection, stored);
  await f.apply([]);
  assert.equal((await f.runtime.modelSelection.getView()).preferredSelection, undefined);
  assert.deepEqual(JSON.parse(await f.raw()).config.defaultModelSelection, stored);
  await f.runtime.providerSettings.applyUcasGatewayProvisioning({
    baseUrl: "https://legacy.example.test/v1",
    apiKey: "synthetic-legacy-key",
    replaceApiKey: true,
  });
  assert.deepEqual((await f.runtime.modelSelection.getView()).preferredSelection, stored);
});
