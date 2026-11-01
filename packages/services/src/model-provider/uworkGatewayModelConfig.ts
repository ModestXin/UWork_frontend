import { z } from "zod";
import {
  parseModelConfig,
  type ModelConfigObject,
  type ProviderSettingsFacade,
  type ProviderSettingsView,
} from "@zcode/provider";
import type { UWorkGatewayModelDescriptor } from "../ucas-gateway/contract.js";

const descriptorSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().trim().min(1).max(200).optional(),
    contextWindow: z.number().int().min(128).max(2000000),
    maxOutputTokens: z.number().int().min(1).max(131072),
    supportsVision: z.boolean(),
    supportsReasoning: z.boolean(),
    supportsTools: z.boolean(),
  })
  .strict();

/** 后端事实覆盖opaque ID的精确规则；禁止继承UCAS的1M/Vision/max及供应商方言映射。 */
function modelConfig(model: UWorkGatewayModelDescriptor, enabled: boolean): ModelConfigObject {
  return {
    enabled,
    properties: {
      contextWindow: model.contextWindow,
      requiresMfjsToolSchema: false,
      inputFormat: {
        supportsText: true,
        supportsImage: model.supportsVision,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: model.supportsTools,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      maxOutputTokens: { max: model.maxOutputTokens, map: '{"max_tokens": maxOutputTokens}' },
      reasoningLevel: model.supportsReasoning
        ? {
            values: ["low", "medium", "high"],
            map: 'reasoningLevel == "low" || reasoningLevel == "medium" || reasoningLevel == "high" ? {"reasoning_effort": reasoningLevel} : {}',
          }
        : { values: ["none"], map: "{}" },
    },
  };
}

/** 复用Facade/Repository单一写者；这里只接受私有Symbol调用传来的已校验目录描述。 */
export async function applyUWorkGatewayModelConfigs(
  facade: ProviderSettingsFacade,
  initial: ProviderSettingsView,
  descriptors: readonly UWorkGatewayModelDescriptor[] | undefined,
  modelIds: readonly string[],
  isCurrent?: () => boolean,
): Promise<ProviderSettingsView> {
  if (descriptors === undefined) return initial;
  const models = z.array(descriptorSchema).parse(descriptors);
  const allowed = new Set(modelIds),
    seen = new Set<string>();
  for (const model of models) {
    if (!allowed.has(model.id) || seen.has(model.id))
      throw new Error("Invalid managed Gateway model descriptors");
    seen.add(model.id);
  }
  let view = initial;
  for (const model of models) {
    if (isCurrent && !isCurrent()) throw new Error("enterprise_identity_changed");
    const current = view.providers
      .find((p) => p.providerId === "ucas")
      ?.models.find((m) => m.modelId === model.id);
    if (!current) throw new Error("Managed Gateway model missing after membership update");
    const config = parseModelConfig(modelConfig(model, current.enabled)).toJSON();
    if (
      current.useRecommendedConfig !== false &&
      JSON.stringify(current.personalExactConfig) === JSON.stringify(config)
    )
      continue;
    if (isCurrent && !isCurrent()) throw new Error("enterprise_identity_changed");
    view = await facade.savePersonalModelDraft({
      providerId: "ucas",
      originalModelId: model.id,
      nextModelId: model.id,
      personalConfig: config,
      useRecommendedConfig: true,
      basedOnRevision: view.revision,
    });
  }
  return view;
}
