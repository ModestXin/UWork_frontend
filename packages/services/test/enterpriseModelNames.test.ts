import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "@zcode/shared/node";
import {
  createUcasDefaultModelConfig,
  parseProviderConfig,
  projectModelSelectionProviderView,
  type ProviderConfigObject,
} from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "@zcode/provider-node";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { providerSettingsTrustedGatewayProvisioning } from "../src/model-provider/providerFacadeServices.js";
import { createProviderProvisioningSource } from "../src/model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";
import type { UWorkGatewayModelDescriptor } from "../src/ucas-gateway/contract.js";
import type { ProviderProvisioningEnvelope } from "@zcode/shared";

const descriptor = (id: string, name?: string): UWorkGatewayModelDescriptor => ({
  id,
  ...(name === undefined ? {} : { name }),
  contextWindow: 128000,
  maxOutputTokens: 16,
  supportsVision: false,
  supportsReasoning: false,
  supportsTools: false,
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "uwork-model-names-"));
  const path = join(directory, "personal.json");
  const options = {
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
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
  await runtime.start();
  return {
    get runtime() {
      return runtime;
    },
    directory,
    path,
    raw: () => readFile(path, "utf8"),
    apply: (models: readonly UWorkGatewayModelDescriptor[], isCurrent = () => true) =>
      runtime.providerSettings[providerSettingsTrustedGatewayProvisioning]({
        baseUrl: "https://backend.example.test/v1",
        authMode: "enterprise-session",
        modelIds: models.map((model) => model.id),
        managedModels: models,
        isCurrent,
      }),
    names: async () =>
      (await runtime.providerSettings.getView()).providers.find((p) => p.providerId === "ucas")
        ?.personalConfig?.enterpriseModelNames,
    models: async () =>
      (await runtime.modelSelection.getView()).providers.find((p) => p.providerId === "ucas")
        ?.models ?? [],
    restart: async () => {
      runtime.dispose();
      runtime = createProviderRuntime(options);
      await runtime.start();
    },
  };
}

test("managed names replace same-ID labels and remove missing, shrunk and empty metadata", async (t) => {
  const f = await fixture(t);
  await f.apply([descriptor("opaque", "  联动受控模型  "), descriptor("removed", "撤销项")]);
  assert.deepEqual(await f.names(), { opaque: "联动受控模型", removed: "撤销项" });
  assert.equal((await f.models()).find((m) => m.modelId === "opaque")?.displayName, "联动受控模型");
  const originalDefault = (await f.runtime.modelSelection.getView()).preferredSelection;
  const originalConfig = f.runtime.registryService.getModel("ucas", "opaque")?.config.toJSON();
  await f.apply([descriptor("opaque", "新名称")]);
  assert.deepEqual(await f.names(), { opaque: "新名称" });
  assert.equal((await f.models())[0]?.displayName, "新名称");
  assert.deepEqual((await f.runtime.modelSelection.getView()).preferredSelection, originalDefault);
  assert.deepEqual(
    f.runtime.registryService.getModel("ucas", "opaque")?.config.toJSON(),
    originalConfig,
  );
  await f.apply([descriptor("opaque")]);
  assert.deepEqual(await f.names(), {});
  assert.equal((await f.models())[0]?.displayName, undefined);
  await f.apply([]);
  assert.deepEqual(await f.names(), {});
  assert.deepEqual(await f.models(), []);
  await f.restart();
  assert.deepEqual(await f.names(), {});
  assert.deepEqual(await f.models(), []);
});

test("normal save, seed, codec and restart preserve private model names", async (t) => {
  const f = await fixture(t);
  await f.apply([descriptor("opaque", "当前名称")]);
  await f.runtime.providerSettings.savePersonalProviderOverlay("ucas", { visibility: "visible" });
  assert.deepEqual(await f.names(), { opaque: "当前名称" });
  // 公共编辑不拥有企业访问方式；由原Gateway重新建立受管连接后验证播种/重启保留。
  await f.apply([descriptor("opaque", "当前名称")]);
  await f.runtime.configService.ensureSeededPersonalProvider({
    providerId: "ucas",
    templateId: "ucas",
    providerName: "ucas",
    modelIds: ["ucas-deepseek-flash"],
    modelConfig: createUcasDefaultModelConfig(),
  });
  await f.runtime.registryService.refresh("name-seed-regression");
  const decoded = decodeProviderConfigFile(JSON.parse(await f.raw()));
  assert.deepEqual(decoded.providers.get("ucas")?.enterpriseModelNames, { opaque: "当前名称" });
  assert.deepEqual(
    decodeProviderConfigFile(encodeProviderConfigFile(decoded)).providers.get("ucas")
      ?.enterpriseModelNames,
    { opaque: "当前名称" },
  );
  await f.restart();
  assert.equal((await f.models())[0]?.displayName, "当前名称");
  assert.deepEqual(
    (await f.runtime.modelSelection.getView()).providers[0]?.config.enterpriseModelNames,
    {
      opaque: "当前名称",
    },
  );
});

test("only current UCAS enterprise candidates project own-key names", async (t) => {
  const f = await fixture(t);
  await f.apply([descriptor("constructor"), descriptor("toString"), descriptor("__proto__")]);
  for (const model of await f.models()) assert.equal(model.displayName, undefined);
  await f.apply([descriptor("opaque", "当前名称")]);
  const provider = f.runtime.registryService.getProvider("ucas");
  assert.ok(provider);
  const registry = f.runtime.registryService
    .getView()
    .providers.find((p) => p.providerId === "ucas");
  assert.ok(registry);
  assert.equal(
    projectModelSelectionProviderView({ ...registry, providerId: "other" }).models[0]?.displayName,
    undefined,
  );
  const raw = JSON.parse(await f.raw());
  const rule = raw.config.providerConfigRules.providerRules.find(
    (p: { providerId: string }) => p.providerId === "ucas",
  );
  rule.config.access = { type: "api-key", apiKey: "controlled-legacy-key" };
  await writeFile(f.path, JSON.stringify(raw), { mode: 0o600 });
  await f.runtime.registryService.refresh("legacy-name-regression");
  for (const model of await f.models()) assert.equal(model.displayName, undefined);
  assert.deepEqual(
    await f.names(),
    { opaque: "当前名称" },
    "legacy ignores but does not destroy private metadata",
  );
});

test("public create/save/compat provisioning cannot write names", async (t) => {
  const f = await fixture(t);
  await f.apply([descriptor("opaque", "当前名称")]);
  for (const value of [{ opaque: "伪造名称" }, {}, null]) {
    const config = { enterpriseModelNames: value } as ProviderConfigObject;
    await assert.rejects(
      f.runtime.providerSettings.createPersonalProvider({ initialConfig: config }),
      /enterprise_session_private_only/,
    );
    await assert.rejects(
      f.runtime.providerSettings.savePersonalProviderOverlay("ucas", config),
      /enterprise_session_private_only/,
    );
    await assert.rejects(
      f.runtime.configService.createPersonalProvider({
        initialConfig: parseProviderConfig(config),
      }),
      /enterprise_session_private_only/,
    );
    await assert.rejects(
      f.runtime.configService.savePersonalProviderOverlay("ucas", parseProviderConfig(config)),
      /enterprise_session_private_only/,
    );
  }
  await assert.rejects(
    f.runtime.providerSettings.applyUcasGatewayProvisioning({
      baseUrl: "https://backend.example.test/v1",
      modelIds: ["opaque"],
      managedModels: [descriptor("opaque", "伪造名称")],
      enterpriseModelNames: { opaque: "伪造名称" },
      authMode: "enterprise-session",
    } as never),
    /enterprise_session_private_only/,
  );
  await f.runtime.providerSettings.applyUcasGatewayProvisioning({
    baseUrl: "https://backend.example.test/v1",
    modelIds: ["opaque"],
    managedModels: [descriptor("opaque", "伪造名称")],
  } as never);
  assert.deepEqual(await f.names(), { opaque: "当前名称" });
});

test("same-ID owner collision and a stale clear behind the repository lock retain the newer name", async (t) => {
  const f = await fixture(t);
  await f.apply([descriptor("same", "旧成员名称")]);
  await f.apply([descriptor("same", "当前成员名称")]);
  const before = await f.raw();
  let release!: () => void, acquired!: () => void, checked!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const entered = new Promise<void>((done) => {
    acquired = done;
  });
  const prechecked = new Promise<void>((done) => {
    checked = done;
  });
  const lock = withFileLock(f.path, async () => {
    acquired();
    await held;
  });
  await entered;
  let current = true,
    checks = 0;
  const rejected = assert.rejects(
    f.apply([], () => {
      if (++checks === 2) checked();
      return current;
    }),
    /enterprise_identity_changed/,
  );
  try {
    await prechecked;
    current = false;
  } finally {
    release();
  }
  await lock;
  await rejected;
  assert.ok(checks >= 3);
  assert.equal(await f.raw(), before);
  assert.equal((await f.models())[0]?.displayName, "当前成员名称");
  await assert.rejects(
    f.apply([descriptor("same", "旧异步名称")], () => false),
    /enterprise_identity_changed/,
  );
  assert.equal(await f.raw(), before);
});

test("invalid descriptors and a middle capability write failure never publish partial names", async (t) => {
  const f = await fixture(t);
  for (const name of [" ", "x".repeat(201), 1, null]) {
    await f.apply([descriptor("old", "旧名称")]);
    await assert.rejects(
      f.apply([descriptor("first", "第一项"), { ...descriptor("bad"), name } as never]),
    );
    assert.deepEqual(await f.names(), {});
    assert.deepEqual(await f.models(), []);
  }
  await f.apply([descriptor("old", "旧名称")]);
  const save = f.runtime.configService.savePersonalModelDraft.bind(f.runtime.configService);
  f.runtime.configService.savePersonalModelDraft = async (...args) => {
    if (args[1] === "failed") throw new Error("controlled capability writer failure");
    return save(...args);
  };
  await assert.rejects(
    f.apply([descriptor("first", "第一项"), descriptor("failed", "不应发布")]),
    /controlled capability writer failure/,
  );
  assert.deepEqual(await f.names(), {});
  assert.deepEqual(await f.models(), []);
  await f.restart();
  assert.deepEqual(await f.names(), {});
  assert.deepEqual(await f.models(), []);
});

test("remote source strips names without changing local private metadata or other envelope facts", async (t) => {
  const f = await fixture(t);
  await f.apply([descriptor("opaque", "本机名称")]);
  const before = await f.raw();
  const repository = new NodePersonalProviderConfigRepository({
    filePath: f.path,
    pollingIntervalMs: false,
  });
  t.after(() => repository.dispose());
  const source = createProviderProvisioningSource({
    personalRepository: repository,
    personalConfigFilePath: f.path,
    credentialFilePath: join(f.directory, "absent-credentials.json"),
    settingService: { get: async () => ({}) } as never,
  });
  const envelope = await source.read("names-export");
  const decoded = decodeProviderConfigFile({ schemaVersion: 1, config: envelope.personalConfig });
  assert.equal(decoded.providers.get("ucas")?.enterpriseModelNames, undefined);
  const expected = JSON.parse(before).config;
  for (const rule of expected.providerConfigRules.providerRules)
    delete rule.config.enterpriseModelNames;
  assert.deepEqual(envelope.personalConfig, expected);
  assert.equal(await f.raw(), before);
});

test("remote target rejects names before runtime, settings, credentials or Repository writes", async (t) => {
  const f = await fixture(t);
  let touched = 0;
  const unexpected = async () => {
    touched++;
    throw new Error("unexpected side effect");
  };
  const target = createProviderProvisioningTarget({
    providerRuntime: { start: unexpected } as never,
    personalRepository: { update: unexpected, read: unexpected } as never,
    accountProviderSource: { refresh: unexpected } as never,
    credentialService: { save: unexpected, delete: unexpected } as never,
    settingService: { get: unexpected, update: unexpected } as never,
    personalConfigFilePath: f.path,
    stateFilePath: join(f.directory, "provisioning.json"),
  });
  const personalConfig = JSON.parse(await f.raw()).config;
  const rule = personalConfig.providerConfigRules.providerRules[0];
  for (const value of [{ opaque: "远端伪造" }, {}, null, undefined]) {
    rule.config.enterpriseModelNames = value;
    await assert.rejects(
      target.apply({
        schemaVersion: 1,
        syncId: "forged-names",
        personalConfig,
        accountSettings: { providerFamilyDomain: null, providerFamilyConnectionSelections: {} },
        credentials: [],
      } as ProviderProvisioningEnvelope),
      /enterprise_model_names_private_only/,
    );
  }
  assert.equal(touched, 0);
});
