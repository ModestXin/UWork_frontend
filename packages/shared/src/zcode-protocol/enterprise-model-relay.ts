import { z } from "zod";
import { zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";

/** 只传正文、有界响应字节和不透明 owner 证明；不传鉴权头、Token、供应商 Key 或可读身份资料。 */
export const zcodeEnterpriseModelRequestParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    requestId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    request: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("open"),
          ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
          url: z.string().min(1).max(4096),
          body: z
            .string()
            .max(1048576)
            .refine((value) => new TextEncoder().encode(value).length <= 1048576),
        })
        .strict(),
      z.object({ kind: z.literal("read"), streamId: z.string().min(1).max(200) }).strict(),
      z.object({ kind: z.literal("close"), streamId: z.string().min(1).max(200) }).strict(),
    ]),
  })
  .strict();
export const zcodeEnterpriseModelRequestResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      streamId: z.string().min(1).max(200).optional(),
      httpStatus: z.number().int().min(200).max(599).optional(),
      contentType: z.enum(["application/json", "text/event-stream"]).optional(),
      chunk: z
        .string()
        .max(87384)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
        .optional(),
      done: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ status: z.literal("denied"), code: z.string().regex(/^enterprise_[a-z_]{1,64}$/) })
    .strict(),
]);
export type ZCodeEnterpriseModelRequestParams = z.infer<
  typeof zcodeEnterpriseModelRequestParamsSchema
>;
export type ZCodeEnterpriseModelRequestResult = z.infer<
  typeof zcodeEnterpriseModelRequestResultSchema
>;
