import { UCAS_PROVIDER_ID } from "@zcode/provider";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";

type UcasApiKeyService = Pick<IProviderSettingsService, "setUcasApiKeyIfMissing">;

export function hasConfiguredUcasApiKey(view: ProviderSettingsView): boolean {
  const access = view.providers.find((provider) => provider.providerId === UCAS_PROVIDER_ID)
    ?.personalConfig?.access;
  return access?.type === "api-key" && Boolean(access.apiKey?.trim());
}

/** 企业会话不需要模型 Key；同步失败也不能诱导用户把上游密钥录入客户端。 */
export function shouldRequestUcasApiKey(
  view: ProviderSettingsView,
  authMode?: "enterprise-session",
): boolean {
  const access = view.providers.find((provider) => provider.providerId === UCAS_PROVIDER_ID)
    ?.personalConfig?.access;
  return (
    authMode !== "enterprise-session" &&
    access?.type !== "enterprise-session" &&
    !hasConfiguredUcasApiKey(view)
  );
}

export async function saveUcasApiKey(service: UcasApiKeyService, key: string): Promise<void> {
  const apiKey = key.trim();
  if (!apiKey) throw new Error("UCAS API Key 不能为空");

  await service.setUcasApiKeyIfMissing(apiKey);
}
