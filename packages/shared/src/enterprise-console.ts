import { z } from "zod";

const id = z.string().min(1).max(256);
export const enterpriseMenuSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    nameEn: z.string().min(1).max(200),
    enabled: z.boolean(),
    builtin: z.boolean(),
    url: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      })
      .optional(),
    icon: z.enum(["message", "bot", "library", "globe", "folder"]),
  })
  .strict()
  .refine((menu) =>
    menu.builtin
      ? ["chat", "agents", "assets"].includes(menu.id)
      : !!menu.url && !["chat", "agents", "assets"].includes(menu.id),
  );
export type EnterpriseMenu = z.infer<typeof enterpriseMenuSchema>;
export const enterpriseNavigationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unmanaged") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
  z
    .object({
      status: z.literal("ready"),
      version: z.number().int().nonnegative(),
      items: z.array(enterpriseMenuSchema).max(50),
    })
    .strict(),
]);
export type EnterpriseNavigation = z.infer<typeof enterpriseNavigationSchema>;
export const enterpriseAgentSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    publishedVersion: z.number().int().positive(),
    modelId: id.optional(),
  })
  .strict();
export type EnterpriseAgent = z.infer<typeof enterpriseAgentSchema>;
export const enterpriseRunSchema = z
  .object({
    id,
    agentId: id,
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]),
    sessionId: id,
    createdAt: z.number().int().nonnegative(),
    errorCode: z.string().max(128).nullable(),
    startedAt: z.number().int().nonnegative().nullable(),
    finishedAt: z.number().int().nonnegative().nullable(),
    input: z.string().max(100000).nullable().optional(),
    output: z.string().max(1048576).nullable().optional(),
  })
  .strict();
export type EnterpriseRun = z.infer<typeof enterpriseRunSchema>;
export const enterpriseRunPageSchema = z
  .object({
    items: z.array(enterpriseRunSchema).max(100),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive().max(100),
  })
  .strict();
export type EnterpriseRunPage = z.infer<typeof enterpriseRunPageSchema>;
export const enterpriseAssetMetadataSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    kind: z.enum(["skill", "expert", "connector", "playbook", "instruction"]),
    version: z.number().int().positive(),
    checksum: z.string().max(128),
    categoryId: z.string().max(256).nullable().optional(),
    distributed: z.boolean(),
  })
  .strict();
export type EnterpriseAssetMetadata = z.infer<typeof enterpriseAssetMetadataSchema>;
