import type {
  ProviderSettingsPolicy,
  ProviderSettingsPolicyScope,
} from "./uworkProviderSettingsPolicy.js";
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  type ModelConfigObject,
  type ModelId,
  type ModelSelection,
  type ModelSelectionFacade,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderConfigObject,
  type ProviderId,
  type ProviderSettingsFacade,
  type ProviderSettingsCreationResult,
  type ModelConfigResolution,
  type ProviderSettingsView,
  type ResolveModelConfigInput,
  type SavePersonalModelDraftInput,
} from "@zcode/provider";
import { createServiceDescriptor } from "../descriptors.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { UWorkGatewayModelDescriptor } from "../ucas-gateway/contract.js";
import { createGatewayProviderProvisioning } from "./gatewayProviderProvisioning.js";

export type {
  ProviderSettingsProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderSettingsView,
} from "@zcode/provider";

export interface ProviderModelDiscoveryResult {
  readonly view: ProviderSettingsView;
  readonly discovered: number;
  readonly added: number;
  readonly skipped: number;
}
export type ProviderModelDiscoverer = (
  config: ProviderConfigObject,
  scope?: ProviderSettingsPolicyScope,
) => Promise<readonly string[]>;

/** Symbol入口只供Root的现有Gateway owner使用，string RPC不能调用。 */
export const providerSettingsTrustedGatewayProvisioning = Symbol(
  "providerSettingsTrustedGatewayProvisioning",
);
export type HostProviderSettingsService = IProviderSettingsService & {
  [providerSettingsTrustedGatewayProvisioning](
    input: TrustedUcasGatewayProvisioningInput,
  ): Promise<UcasGatewayProvisioningResult>;
};

/** 企业网关写入 Provider 的入参/结果；模型只追加，Key 只补缺或显式替换。 */
export interface UcasGatewayProvisioningInput {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly replaceApiKey?: boolean;
  readonly modelIds?: readonly string[];
}

/** 只供Host私有Symbol端口消费；公开个人配置方法不读取该字段。 */
export interface TrustedUcasGatewayProvisioningInput extends UcasGatewayProvisioningInput {
  readonly clearManagedCatalog?: true;
  readonly managedModels?: readonly UWorkGatewayModelDescriptor[];
  readonly authMode?: "enterprise-session";
  readonly isCurrent?: () => boolean;
}

export interface UcasGatewayProvisioningResult {
  readonly view: ProviderSettingsView;
  readonly apiKeyApplied: boolean;
  readonly hasApiKey: boolean;
  readonly modelsAdded: number;
  readonly modelsSkipped: number;
}

export interface IProviderSettingsService {
  readonly onDidChange: Event<ProviderSettingsView>;
  getView(): Promise<ProviderSettingsView>;
  discoverModels(providerId: ProviderId): Promise<ProviderModelDiscoveryResult>;
  refresh(reason: string): Promise<ProviderSettingsView>;
  createPersonalProvider(
    input?: Parameters<ProviderSettingsFacade["createPersonalProvider"]>[0],
  ): Promise<ProviderSettingsCreationResult>;
  resolveModelConfig(input: ResolveModelConfigInput): Promise<ModelConfigResolution>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Parameters<ProviderSettingsFacade["savePersonalProviderOverlay"]>[2],
  ): Promise<ProviderSettingsView>;
  setUcasApiKeyIfMissing(apiKey: string): Promise<ProviderSettingsView>;
  /** 企业网关自动配置：网关地址必写，Key 只补缺/显式替换，模型按套餐追加。 */
  applyUcasGatewayProvisioning(
    input: UcasGatewayProvisioningInput,
  ): Promise<UcasGatewayProvisioningResult>;
  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView>;
  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView>;
  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView>;
  /** 测试已经保存并进入目标 Environment Registry 的正式 Model。 */
  testModelConnectivity(
    input: ProviderSettingsConnectivityRequest,
  ): Promise<ModelConnectivityResult>;
}

export const IProviderSettingsService = createServiceDescriptor<IProviderSettingsService>(
  ServiceChannels.ProviderSettings,
);

export interface ProviderSettingsConnectivityTestInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export interface ProviderSettingsConnectivityRequest {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export type ProviderSettingsConnectivityTester = (
  input: ProviderSettingsConnectivityTestInput,
) => Promise<ModelConnectivityResult>;

export interface IModelSelectionService {
  readonly onDidChange: Event<ModelSelectionView>;
  getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView>;
}

export interface ModelSelectionConfiguredDefaultSource {
  read(): Promise<ModelSelection | undefined>;
  onDidChange?(listener: () => void): () => void;
}

export const IModelSelectionService = createServiceDescriptor<IModelSelectionService>(
  ServiceChannels.ModelSelection,
);

export function createProviderSettingsService(
  facade: ProviderSettingsFacade,
  ensureReady: () => Promise<void> = async () => {},
  testConnectivity?: ProviderSettingsConnectivityTester,
  discoverModels?: ProviderModelDiscoverer,
  policy?: ProviderSettingsPolicy,
): HostProviderSettingsService {
  const admitted = <T>(operation: (scope?: ProviderSettingsPolicyScope) => Promise<T>) =>
    policy ? policy.run(operation) : operation();
  const personal = <T>(operation: () => Promise<T>) =>
    admitted(async (scope) => {
      await ensureReady();
      await scope?.authorize("personal");
      const result = await operation();
      await scope?.authorize("personal");
      return result;
    });
  const providerUrl = (providerId: ProviderId) =>
    facade.getView().providers.find((item) => item.providerId === providerId)?.effectiveConfig.api
      ?.baseUrl ?? undefined;
  const inFlight = new Map<string, Promise<ProviderModelDiscoveryResult>>();
  const discover = (providerId: string): Promise<ProviderModelDiscoveryResult> =>
    admitted(async (scope) => {
      await ensureReady();
      await facade.waitForProviderOperations(providerId);
      await scope?.authorize("personal");
      const before = facade.getView();
      const provider = before.providers.find((item) => item.providerId === providerId);
      if (!provider || provider.effectiveConfig.group !== "standard-personal")
        throw new Error("请选择自定义供应商");
      if (!discoverModels) throw new Error("当前 Host 不支持自动获取模型，请更新 Host");
      const ids = await discoverModels(provider.effectiveConfig, scope);
      await scope?.authorize("personal", provider.effectiveConfig.api?.baseUrl ?? undefined);
      const existing = new Set(provider.models.map((model) => model.modelId));
      const added = ids.filter((id) => !existing.has(id)).length;
      const view = await facade.addDiscoveredModels(providerId, ids, before.revision);
      await scope?.authorize("personal", provider.effectiveConfig.api?.baseUrl ?? undefined);
      return { view, discovered: ids.length, added, skipped: ids.length - added };
    });
  const applyGatewayProvisioning = createGatewayProviderProvisioning(facade, ensureReady);
  return {
    onDidChange: toEvent((listener) => facade.onDidChange(listener)),
    discoverModels: (providerId) => {
      if (typeof providerId !== "string" || !providerId.trim())
        return Promise.reject(new Error("供应商 ID 无效"));
      const running = inFlight.get(providerId);
      if (running) return running;
      const result = discover(providerId);
      inFlight.set(providerId, result);
      const cleanup = () => {
        if (inFlight.get(providerId) === result) inFlight.delete(providerId);
      };
      void result.then(cleanup, cleanup);
      return result;
    },
    getView: async () => {
      await ensureReady();
      return facade.getView();
    },
    refresh: async (reason) => {
      await ensureReady();
      return facade.refresh(reason);
    },
    createPersonalProvider: (input) =>
      personal(() => {
        if (
          input?.initialConfig?.access?.type === "enterprise-session" ||
          input?.initialConfig?.enterpriseModelIds !== undefined ||
          (input?.initialConfig && Object.hasOwn(input.initialConfig, "enterpriseModelNames"))
        )
          throw new Error("enterprise_session_private_only");
        return facade.createPersonalProvider(input);
      }),
    resolveModelConfig: (input) =>
      admitted(async (scope) => {
        await ensureReady();
        await scope?.authorize("resolve", providerUrl(input.providerId));
        const result = facade.resolveModelConfig(input);
        await scope?.authorize("resolve", providerUrl(input.providerId));
        return result;
      }),
    savePersonalProviderOverlay: (providerId, config, metadata) =>
      personal(() => {
        // 公开RPC只能编辑个人配置；无凭据受管模式必须由当前Gateway的私有Symbol入口建立。
        if (
          config.access?.type === "enterprise-session" ||
          config.enterpriseModelIds !== undefined ||
          Object.hasOwn(config, "enterpriseModelNames")
        )
          throw new Error("enterprise_session_private_only");
        return facade.savePersonalProviderOverlay(providerId, config, metadata);
      }),
    setUcasApiKeyIfMissing: (apiKey) => personal(() => facade.setUcasApiKeyIfMissing(apiKey)),
    applyUcasGatewayProvisioning: (input) =>
      personal(() => {
        if (
          Object.hasOwn(input, "enterpriseModelNames") ||
          Object.hasOwn(input, "clearManagedCatalog")
        )
          throw new Error("enterprise_session_private_only");
        return applyGatewayProvisioning(input);
      }),
    // 只有私有Gateway路径透传后台描述；JS伪造公开入参不能改变受管模型事实。
    [providerSettingsTrustedGatewayProvisioning]: (input) =>
      applyGatewayProvisioning(
        input,
        input.managedModels,
        input.authMode === "enterprise-session",
        input.isCurrent,
        input.clearManagedCatalog,
      ),
    deletePersonalProvider: (providerId) =>
      personal(() => facade.deletePersonalProvider(providerId)),
    reorderPersonalProviders: (providerIds) =>
      personal(() => facade.reorderPersonalProviders(providerIds)),
    reorderPersonalModels: (providerId, modelIds) =>
      personal(() => facade.reorderPersonalModels(providerId, modelIds)),
    addPersonalModel: (providerId, modelId, config, useRecommendedConfig) =>
      personal(() => facade.addPersonalModel(providerId, modelId, config, useRecommendedConfig)),
    renamePersonalModel: (providerId, currentModelId, nextModelId) =>
      personal(() => facade.renamePersonalModel(providerId, currentModelId, nextModelId)),
    deletePersonalModel: (providerId, modelId) =>
      personal(() => facade.deletePersonalModel(providerId, modelId)),
    savePersonalModelDraft: (input) => personal(() => facade.savePersonalModelDraft(input)),
    setPersonalModelEnabled: (providerId, modelId, enabled) =>
      personal(() => facade.setPersonalModelEnabled(providerId, modelId, enabled)),
    testModelConnectivity: (input) =>
      admitted(async (scope) => {
        await ensureReady();
        if (!testConnectivity) {
          throw new Error("当前 Environment 未装配模型连通性测试能力");
        }
        await facade.waitForProviderOperations(input.providerId);
        await scope?.authorize("resolve", providerUrl(input.providerId));
        // 禁用对象仍存在于配置视图，但不进入执行 Registry；不能把未发布误报成配置丢失。
        // 只消费操作完成后的公共资格，不另查 Key、权益，也不替代目标 Environment 最终校验。
        const provider = facade
          .getView()
          .providers.find((item) => item.providerId === input.providerId);
        const model = provider?.models.find((item) => item.modelId === input.modelId);
        const unavailable =
          !provider || !provider.enabled
            ? "provider-unavailable"
            : !model || !model.enabled || model.issues.length > 0
              ? "model-unavailable"
              : !provider.executable
                ? "provider-unavailable"
                : !model.executable
                  ? "model-unavailable"
                  : undefined;
        if (unavailable) {
          return {
            success: false,
            error: {
              code: unavailable,
              message:
                unavailable === "provider-unavailable"
                  ? "This provider is currently unavailable for connectivity testing."
                  : "This model is currently unavailable for connectivity testing.",
            },
          };
        }
        const result = await testConnectivity({
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          providerId: input.providerId,
          modelId: input.modelId,
        });
        await scope?.authorize("resolve", providerUrl(input.providerId));
        return result;
      }),
  };
}

export function createModelSelectionService(
  facade: ModelSelectionFacade,
  ensureReady: () => Promise<void> = async () => {},
  configuredDefaultSource?: ModelSelectionConfiguredDefaultSource,
  onDidInvalidateManagedCatalog?: (listener: () => void) => () => void,
): IModelSelectionService & { dispose(): void } {
  const log = createServiceLogger("model-selection");
  let revision = 0;
  let disposed = false;
  const listeners = new Set<(view: ModelSelectionView) => void>();
  const getView = async (input?: ModelSelectionViewInput): Promise<ModelSelectionView> => {
    await ensureReady();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const configuredDefault = await configuredDefaultSource?.read();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const base = facade.getView(configuredDefault);
    if (revision < base.revision) revision = base.revision;
    return facade.getView(configuredDefault, revision, input);
  };
  const emit = (): void => {
    if (disposed) return;
    revision += 1;
    void getView().then(
      (view) => {
        if (disposed) return;
        for (const listener of listeners) listener(view);
      },
      (error: unknown) => {
        // Registry 事件触发的异步 View 重建没有 owner；Host dispose 后它仍会继续
        // 读取已释放的配置仓库，并形成未处理 rejection。dispose 是明确的取消边界；仅在服务
        // 仍存活时记录真实读取失败。
        if (disposed) return;
        log.warn(undefined, `ModelSelection View 刷新失败: ${String(error)}`);
      },
    );
  };
  const disposeFacade = facade.onDidChange(emit);
  const disposeConfiguredDefault = configuredDefaultSource?.onDidChange?.(emit);
  const disposeInvalidation = onDidInvalidateManagedCatalog?.(() => {
    if (disposed) return;
    // 明确撤销先同步发当前候选；不能等待磁盘默认偏好读完才撤掉旧ready。
    revision += 1;
    const { preferredSelection: _preferred, ...current } = facade.getView(undefined, revision);
    for (const listener of listeners) listener(current);
  });

  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getView,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeFacade();
      disposeConfiguredDefault?.();
      disposeInvalidation?.();
      listeners.clear();
    },
  };
}

function toEvent<T>(subscribe: (listener: (event: T) => void) => () => void): Event<T> {
  return (listener) => {
    const dispose = subscribe(listener);
    return { dispose };
  };
}
