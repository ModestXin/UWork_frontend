import { z } from "zod";
import {
  ucasGatewayUserSchema,
  ucasGatewaySubscriptionSchema,
  ucasGatewayUsageStatsSchema,
} from "@zcode/shared";
import {
  UcasGatewayRequestError,
  readJson,
  type UcasGatewayClient,
  type UcasGatewayClientOptions,
} from "./ucasGatewayClient.js";
export function createUWorkGatewayClient(options: UcasGatewayClientOptions): UcasGatewayClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const send = async (path: string, method = "GET", body?: unknown) => {
    // 自有不透明会话必须绑定签发 origin；配置换地址不能把旧凭据试发给新服务。
    if (options.issuerOrigin !== new URL(options.apiBaseUrl).origin)
      throw new UcasGatewayRequestError("unauthorized");
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, options.apiBaseUrl), {
        method,
        redirect: "error",
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 20000)])
          : AbortSignal.timeout(options.timeoutMs ?? 20000),
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new UcasGatewayRequestError("network");
    }
    // 控制面402表示订阅准入失效，不能保留旧授权快照；模型POST额度错误走独立relay。
    if (!response.ok)
      throw new UcasGatewayRequestError(
        response.status === 401
          ? "unauthorized"
          : response.status === 402 || response.status === 403
            ? "forbidden"
            : "http",
        response.status,
      );
    return readJson(response);
  };
  return {
    async retireDeviceCredential(keyId) {
      await send(`/api/auth/device-tokens/${encodeURIComponent(keyId)}`, "DELETE");
    },
    async readProfile() {
      const me = z
        .object({
          user: z.object({ id: z.string(), name: z.string(), email: z.string().nullable() }),
          tenant: z.object({ id: z.string() }),
          role: z.string(),
          membership: z
            .object({
              source: z.string(),
              externalId: z.string().nullable(),
              department: z.object({ id: z.string(), name: z.string() }).nullable(),
            })
            .optional(),
        })
        .parse(await send("/api/auth/me"));
      // 当前后台已给出成员映射：不能再硬编码空部门/企微ID，或把不同平台角色折叠成user。
      return ucasGatewayUserSchema.parse({
        id: me.user.id,
        orgId: me.tenant.id,
        name: me.user.name,
        role: me.role,
        wecomUserId: me.membership?.externalId ?? null,
        email: me.user.email,
        avatar: null,
        department: me.membership?.department?.name ?? null,
        position: null,
        monthlyBudgetUsd: null,
      });
    },
    async listKeys() {
      return [];
    },
    async generateKey() {
      throw new UcasGatewayRequestError("invalid");
    },
    async revealKey() {
      throw new UcasGatewayRequestError("invalid");
    },
    async readGatewayEndpoints() {
      return { publicBaseUrl: new URL("/v1", options.apiBaseUrl).href, internalBaseUrl: null };
    },
    async readSubscriptions() {
      return [ucasGatewaySubscriptionSchema.parse(await send("/api/client/entitlement"))];
    },
    async readUsage(input) {
      const params = new URLSearchParams({ period: input.period, metric: input.metric });
      return ucasGatewayUsageStatsSchema.parse(await send(`/api/client/usage?${params}`));
    },
    async readPlanModels() {
      const raw = z
        .object({
          data: z.array(
            z.object({
              id: z.string().min(1).max(80),
              name: z.string().trim().min(1).max(200).optional(),
              context_window: z.number().int().min(128).max(2000000),
              max_output_tokens: z.number().int().min(1).max(131072),
              supports_vision: z.boolean(),
              supports_reasoning: z.boolean(),
              supports_tools: z.boolean(),
            }),
          ),
        })
        .parse(await send("/v1/models"));
      return {
        models: raw.data.map((m) => m.id),
        descriptors: raw.data.map((m) => ({
          id: m.id,
          ...(m.name === undefined ? {} : { name: m.name }),
          contextWindow: m.context_window,
          maxOutputTokens: m.max_output_tokens,
          supportsVision: m.supports_vision,
          supportsReasoning: m.supports_reasoning,
          supportsTools: m.supports_tools,
        })),
        unrestricted: false,
        hasSubscription: true,
      };
    },
    async listEndpointModels() {
      const raw = z
        .object({ data: z.array(z.object({ id: z.string() })) })
        .parse(await send("/v1/models"));
      return raw.data.map((m) => m.id);
    },
  };
}
