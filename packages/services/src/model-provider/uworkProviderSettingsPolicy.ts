import { z } from "zod";
import type { ProviderConfigObject } from "@zcode/provider";
import type { ApiRequestInit } from "@zcode/shared";
import {
  UWorkBackendSessionError,
  uworkSecuritySchema,
  type UWorkBackendSession,
} from "../enterprise-identity/backendSessionContract.js";
import { discoverProviderModels } from "./providerModelDiscovery.js";

export type ProviderSettingsPolicyIntent = "personal" | "resolve";
export interface ProviderSettingsPolicyScope {
  readonly signal?: AbortSignal;
  authorize(intent: ProviderSettingsPolicyIntent, target?: string): Promise<void>;
}
export interface ProviderSettingsPolicy {
  run<T>(operation: (scope: ProviderSettingsPolicyScope) => Promise<T>): Promise<T>;
}
export class ProviderSettingsPolicyError extends Error {
  constructor(readonly code: string) {
    super(
      code === "enterprise_personal_models_denied"
        ? "企业未允许个人模型配置"
        : "企业模型配置授权不可用",
    );
    this.name = "ProviderSettingsPolicyError";
  }
}
const responseSchema = z.object({
  allowed: z.literal(true),
  tenantId: z.string().min(1),
  security: uworkSecuritySchema,
  personal: z
    .object({ models: z.boolean(), skills: z.boolean(), connectors: z.boolean() })
    .strict(),
});
function deny(code = "enterprise_policy_unavailable"): never {
  throw new ProviderSettingsPolicyError(code);
}

export function createUWorkProviderSettingsPolicy(
  resolveBackend: () => UWorkBackendSession,
): ProviderSettingsPolicy {
  return {
    async run(operation) {
      try {
        const backend = resolveBackend();
        const result = await backend.run(async (scope) =>
          operation({
            signal: scope.signal,
            async authorize(intent, target) {
              const response = await scope.request("/api/client/authorize", {
                action: "execution",
                channel: "local",
              });
              const parsed = responseSchema.safeParse(response.body);
              if (
                response.status !== 200 ||
                !parsed.success ||
                parsed.data.tenantId !== scope.tenantId
              )
                deny();
              let url: URL | undefined;
              if (target !== undefined) {
                try {
                  url = new URL(target);
                } catch {
                  deny();
                }
                if (
                  !["http:", "https:"].includes(url.protocol) ||
                  url.username ||
                  url.password ||
                  (intent === "resolve" && url.search) ||
                  url.hash
                )
                  deny();
              }
              // 只消费Registry的实际地址和私有issuer，公开Provider ID/名称不构成企业豁免。
              const managed =
                intent === "resolve" &&
                url?.origin === scope.origin &&
                (url.pathname === "/v1" || url.pathname.startsWith("/v1/"));
              if (!managed && !parsed.data.personal.models)
                deny("enterprise_personal_models_denied");
              if (
                intent === "personal" &&
                url &&
                (!parsed.data.security.allowNetwork ||
                  (parsed.data.security.allowedDomains.length > 0 &&
                    !parsed.data.security.allowedDomains.includes(url.hostname)))
              )
                deny("enterprise_network_denied");
              await scope.assertCurrent();
            },
          }),
        );
        if (result.managed) return result.value;
        return await operation({
          async authorize() {
            await backend.run(async () => deny("enterprise_configuration_changed"));
          },
        });
      } catch (error) {
        if (error instanceof UWorkBackendSessionError) deny(error.code);
        throw error;
      }
    },
  };
}

/** 复用Host唯一网络出口；设置/CA/dispatcher异步准备后仍须重新裁决实际目标。 */
export async function discoverPolicyAwareProviderModels(
  config: ProviderConfigObject,
  request: typeof fetch,
  scope?: ProviderSettingsPolicyScope,
) {
  let admissionError: unknown;
  let rejected = false;
  const authorize = async (target: string) => {
    try {
      await scope?.authorize("personal", target);
    } catch (error) {
      rejected = true;
      admissionError = error;
      throw error;
    }
  };
  try {
    return await discoverProviderModels(config, {
      request: async (input, init) => {
        let target = String(input);
        await authorize(target);
        const signals = [init?.signal, scope?.signal].filter(
          (signal): signal is AbortSignal => !!signal,
        );
        const options: ApiRequestInit = {
          ...init,
          ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
          ...(scope
            ? {
                beforeDispatch: async (actual: string) => {
                  await authorize(actual);
                  target = actual;
                },
              }
            : {}),
        };
        const response = await request(input, options);
        await authorize(target);
        return response;
      },
    });
  } catch (error) {
    // 旧发现器会将请求错误归为网络失败；企业拒绝必须保留稳定错误归属。
    if (rejected) throw admissionError;
    throw error;
  }
}
