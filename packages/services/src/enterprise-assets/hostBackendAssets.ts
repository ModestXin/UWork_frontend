import { z } from "zod";
import {
  uworkSecuritySchema,
  type UWorkBackendScope,
} from "../enterprise-identity/backendSessionContract.js";
import { EnterpriseAssetStoreError, type EnterpriseAssetBinding } from "./assetPackage.js";

const bindingSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  kind: z.enum(["skill", "expert", "playbook", "instruction", "connector"]),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(200),
  distributed: z.boolean(),
});
const manifestSchema = z
  .object({ items: z.array(bindingSchema).max(1000) })
  .refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length);
const executionSchema = z.object({
  allowed: z.literal(true),
  tenantId: z.string(),
  security: uworkSecuritySchema,
  personal: z.object({ skills: z.boolean() }),
});
const decisionSchema = z.object({ allowed: z.boolean(), tenantId: z.string() });
const failure = (code: string) => new EnterpriseAssetStoreError(code);
function accepted(response: { status: number; body: unknown }): unknown {
  if (response.status < 200 || response.status >= 300)
    throw failure(
      response.status === 402
        ? "enterprise_subscription_inactive"
        : "enterprise_policy_unavailable",
    );
  return response.body;
}
export async function readHostSkillPolicy(scope: UWorkBackendScope) {
  const execution = executionSchema.safeParse(
    accepted(
      await scope.request("/api/client/authorize", { action: "execution", channel: "local" }),
    ),
  );
  if (!execution.success || execution.data.tenantId !== scope.tenantId)
    throw failure("enterprise_policy_unavailable");
  return {
    allowFilesystem: execution.data.security.allowFilesystem,
    dangerousSkills: execution.data.security.dangerousSkills,
    personalSkills: execution.data.personal.skills,
  };
}
export type HostAssetBinding = EnterpriseAssetBinding & {
  name: string;
  distributed: boolean;
};
export type HostConnectorBinding = {
  id: string;
  kind: "connector";
  version: number;
  checksum: string;
  name: string;
  distributed: boolean;
};
export type HostManifest = {
  assets: HostAssetBinding[];
  connectors: HostConnectorBinding[];
};
export async function readHostAssetManifest(scope: UWorkBackendScope): Promise<HostManifest> {
  const parsed = manifestSchema.safeParse(accepted(await scope.request("/api/client/assets")));
  if (!parsed.success) throw failure("enterprise_assets_invalid");
  const items = [...parsed.data.items].sort((left, right) => left.id.localeCompare(right.id));
  return {
    // 已落盘类型：技能与专家；playbook/instruction 没有当前终端所有者
    // （服务端矩阵已不下发给 uwork），这里再拒绝一次，不能只依赖对端过滤。
    assets: items.filter(
      (item): item is HostAssetBinding => item.kind === "skill" || item.kind === "expert",
    ),
    // 连接器没有可安装正文，只作为目录元数据参与逐次准入。
    connectors: items.filter((item): item is HostConnectorBinding => item.kind === "connector"),
  };
}
/** 准入只绑定 ID/发布版本/校验和；kind 由服务端按当前发布内容判定。 */
export type HostAssetAdmission = {
  id: string;
  version: number;
  checksum: string;
};
export async function authorizeHostAsset(
  scope: UWorkBackendScope,
  binding: HostAssetAdmission,
): Promise<boolean> {
  const parsed = decisionSchema.safeParse(
    accepted(
      await scope.request("/api/client/authorize", {
        action: "asset",
        channel: "local",
        target: binding.id,
        assetVersion: binding.version,
        assetChecksum: binding.checksum,
      }),
    ),
  );
  if (!parsed.success || parsed.data.tenantId !== scope.tenantId)
    throw failure("enterprise_policy_unavailable");
  return parsed.data.allowed;
}
/** 掩码描述：只有 transport/description 与网关路径，没有远端地址或凭据。 */
const connectorDescriptorSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    kind: z.literal("connector"),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    content: z
      .object({
        transport: z.literal("streamable-http"),
        description: z.string().max(2000),
      })
      .strict(),
    gatewayUrl: z.string().regex(/^\/api\/client\/connectors\/[A-Za-z0-9_-]{1,80}\/rpc$/),
  })
  .strict();
export type HostConnectorDescriptor = {
  transport: "streamable-http";
  description: string;
  gatewayUrl: string;
};
export async function downloadHostConnector(
  scope: UWorkBackendScope,
  binding: HostAssetAdmission,
): Promise<HostConnectorDescriptor> {
  const parsed = connectorDescriptorSchema.safeParse(
    await accepted(
      await scope.request(`/api/client/assets/${binding.id}/download?version=${binding.version}`),
    ),
  );
  if (
    !parsed.success ||
    parsed.data.id !== binding.id ||
    parsed.data.version !== binding.version ||
    parsed.data.gatewayUrl !== `/api/client/connectors/${binding.id}/rpc`
  )
    throw failure("enterprise_assets_invalid");
  return {
    transport: parsed.data.content.transport,
    description: parsed.data.content.description,
    gatewayUrl: parsed.data.gatewayUrl,
  };
}
export async function downloadHostAsset(scope: UWorkBackendScope, binding: EnterpriseAssetBinding) {
  return accepted(
    await scope.request(`/api/client/assets/${binding.id}/download?version=${binding.version}`),
  );
}
