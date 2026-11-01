import { UCAS_PROVIDER_ID, type ProviderSettingsFacade } from "@zcode/provider";
import type { UWorkGatewayModelDescriptor } from "../ucas-gateway/contract.js";
import type {
  UcasGatewayProvisioningInput,
  UcasGatewayProvisioningResult,
} from "./providerFacadeServices.js";
import { applyUWorkGatewayModelConfigs } from "./uworkGatewayModelConfig.js";

/** 无独立状态的私有编排：事实仍来自Gateway，磁盘与Registry仍归既有Facade/Repo。 */
export function createGatewayProviderProvisioning(
  facade: ProviderSettingsFacade,
  ensureReady: () => Promise<void>,
) {
  return async (
    input: UcasGatewayProvisioningInput,
    managedModels?: readonly UWorkGatewayModelDescriptor[],
    enterpriseSession = false,
    isCurrent?: () => boolean,
    clearManagedCatalog?: true,
  ): Promise<UcasGatewayProvisioningResult> => {
    await ensureReady();
    if (clearManagedCatalog && !isCurrent) throw new Error("enterprise_identity_changed");
    if (isCurrent && !isCurrent()) throw new Error("enterprise_identity_changed");
    if (clearManagedCatalog) {
      const cleared = await facade.applyUcasGatewayConfig({
        baseUrl: input.baseUrl,
        clearManagedCatalog: true,
        ...(isCurrent ? { isCurrent } : {}),
      });
      return {
        view: cleared.view,
        apiKeyApplied: false,
        hasApiKey: false,
        modelsAdded: 0,
        modelsSkipped: 0,
      };
    }
    await facade.waitForProviderOperations(UCAS_PROVIDER_ID);
    if (isCurrent && !isCurrent()) throw new Error("enterprise_identity_changed");
    // 复用既有唯一Writer原子清旧Key并更新endpoint，不能先发布仍有凭据的中间投影。
    const applied = await facade.applyUcasGatewayConfig({
      baseUrl: input.baseUrl,
      ...(enterpriseSession
        ? {
            authMode: "enterprise-session" as const,
            enterpriseModelIds: [],
            ...(isCurrent ? { isCurrent } : {}),
          }
        : {
            ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
            ...(input.replaceApiKey === undefined ? {} : { replaceApiKey: input.replaceApiKey }),
          }),
    });
    if (isCurrent && !isCurrent()) throw new Error("enterprise_identity_changed");
    const provider = applied.view.providers.find((item) => item.providerId === UCAS_PROVIDER_ID);
    if (!provider) throw new Error("UCAS 默认供应商不可用");
    const ids = [
      ...new Set((input.modelIds ?? []).map((modelId) => modelId.trim()).filter(Boolean)),
    ];
    const existing = new Set(provider.models.map((model) => model.modelId));
    const added = ids.filter((modelId) => !existing.has(modelId));
    const membershipView =
      added.length === 0
        ? applied.view
        : await facade.addDiscoveredModels(UCAS_PROVIDER_ID, ids, applied.view.revision);
    let view = await applyUWorkGatewayModelConfigs(
      facade,
      membershipView,
      managedModels,
      ids,
      isCurrent,
    );
    if (enterpriseSession && ids.length > 0) {
      // 能力描述就绪后才发布候选，避免opaque ID短暂继承UCAS模板并被默认选中。
      if (isCurrent && !isCurrent()) throw new Error("enterprise_identity_changed");
      view = (
        await facade.applyUcasGatewayConfig({
          baseUrl: input.baseUrl,
          authMode: "enterprise-session",
          enterpriseModelIds: ids,
          enterpriseModelNames: Object.fromEntries(
            (managedModels ?? [])
              .filter((model) => model.name !== undefined)
              .map((model) => [model.id, model.name!.trim()]),
          ),
          ...(isCurrent ? { isCurrent } : {}),
        })
      ).view;
    }
    const effective = view.providers.find((item) => item.providerId === UCAS_PROVIDER_ID);
    const access = effective?.effectiveConfig.access;
    return {
      view,
      apiKeyApplied: applied.apiKeyApplied,
      hasApiKey: Boolean(
        access?.type === "api-key" && typeof access.apiKey === "string" && access.apiKey.trim(),
      ),
      modelsAdded: added.length,
      modelsSkipped: ids.length - added.length,
    };
  };
}
