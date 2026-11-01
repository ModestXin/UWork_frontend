import { z } from "zod";

export const enterpriseSkillBindingSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    kind: z.literal("skill"),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** Host-readable immutable bindings; connector bodies stay behind the backend proxy. */
export const enterpriseAssetBindingSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    kind: z.enum(["skill", "expert"]),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/**
 * 连接器没有可落盘的正文：发布校验和属于服务端私有内容，掩码描述不是该内容。
 * 因此连接器绑定只用于逐次准入，不携带 key/directory。
 */
export const enterpriseConnectorBindingSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    kind: z.literal("connector"),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const enterpriseAssetReferenceSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    asset: enterpriseAssetBindingSchema,
    directory: z.string().min(1).max(4096),
  })
  .strict();
export const enterpriseConnectorAssetReferenceSchema = z
  .object({ asset: enterpriseConnectorBindingSchema })
  .strict();
/** 逐次准入的资产引用：已落盘技能/专家，或只经代理的连接器。 */
export const enterpriseAdmissionAssetSchema = z.union([
  enterpriseAssetReferenceSchema,
  enterpriseConnectorAssetReferenceSchema,
]);
export type EnterpriseConnectorAssetReference = z.infer<
  typeof enterpriseConnectorAssetReferenceSchema
>;
export type EnterpriseAdmissionAsset = z.infer<typeof enterpriseAdmissionAssetSchema>;
export const enterpriseSkillReferenceSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    asset: enterpriseSkillBindingSchema,
    directory: z.string().min(1).max(4096),
  })
  .strict();
export type EnterpriseAssetReference = z.infer<typeof enterpriseAssetReferenceSchema>;
export type EnterpriseSkillReference = z.infer<typeof enterpriseSkillReferenceSchema>;
/** Catalog stays metadata-only: the expert body is read after per-load admission. */
export const enterpriseExpertReferenceSchema = enterpriseAssetReferenceSchema
  .extend({
    asset: enterpriseAssetBindingSchema.extend({ kind: z.literal("expert") }).strict(),
    name: z.string().min(1).max(200),
    distributed: z.boolean(),
  })
  .strict();
export type EnterpriseExpertReference = z.infer<typeof enterpriseExpertReferenceSchema>;
/** 连接器目录项只含元数据：没有目录、没有远端地址、没有凭据。 */
export const enterpriseConnectorReferenceSchema = z
  .object({
    asset: enterpriseConnectorBindingSchema,
    name: z.string().min(1).max(200),
    distributed: z.boolean(),
  })
  .strict();
export type EnterpriseConnectorReference = z.infer<typeof enterpriseConnectorReferenceSchema>;
export const enterpriseSkillsCatalogSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("unmanaged") }).strict(),
    z
      .object({ status: z.literal("denied"), code: z.string().regex(/^enterprise_[a-z_]{1,64}$/) })
      .strict(),
    z
      .object({
        status: z.literal("ready"),
        ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
        allowFilesystem: z.boolean(),
        personalSkills: z.boolean(),
        dangerousSkills: z.boolean(),
        assets: z
          .array(
            enterpriseSkillReferenceSchema
              .extend({ name: z.string().min(1).max(200), distributed: z.boolean() })
              .strict(),
          )
          .max(1000),
        experts: z.array(enterpriseExpertReferenceSchema).max(1000),
        connectors: z.array(enterpriseConnectorReferenceSchema).max(1000),
      })
      .strict(),
  ])
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 1024 * 1024);
export type EnterpriseSkillsCatalog = z.infer<typeof enterpriseSkillsCatalogSchema>;
