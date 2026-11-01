import { z } from "zod";
import {
  uworkPublishedFeatureSchema,
  uworkHelpConfigurationSchema,
  uworkDesktopConfigurationSchema,
} from "./uwork-client-experience.js";

/** Main 只接收当前 Host 验证过的两类显示决定，不接收身份或完整配置。 */
export const desktopClientPresentationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unmanaged") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
  z
    .object({
      status: z.literal("ready"),
      help: uworkPublishedFeatureSchema(uworkHelpConfigurationSchema),
      desktop: uworkPublishedFeatureSchema(uworkDesktopConfigurationSchema),
    })
    .strict(),
]);
export type DesktopClientPresentation = z.infer<typeof desktopClientPresentationSchema>;

export const hostClientPresentationReadMessageSchema = z
  .object({
    type: z.literal("client-presentation-read"),
    requestId: z.string().uuid(),
  })
  .strict();
export type HostClientPresentationReadMessage = z.infer<
  typeof hostClientPresentationReadMessageSchema
>;

export const hostClientPresentationResultSchema = z
  .object({
    type: z.literal("client-presentation-result"),
    requestId: z.string().uuid(),
    sourceEpoch: z.number().int().nonnegative(),
    projection: desktopClientPresentationSchema,
  })
  .strict();
export const hostClientPresentationInvalidatedSchema = z
  .object({
    type: z.literal("client-presentation-invalidated"),
    sourceEpoch: z.number().int().nonnegative(),
  })
  .strict();
export const hostClientPresentationResponseSchema = z.discriminatedUnion("type", [
  hostClientPresentationResultSchema,
  hostClientPresentationInvalidatedSchema,
]);
export type HostClientPresentationResponse = z.infer<typeof hostClientPresentationResponseSchema>;

export function projectDesktopClientPresentation(value: unknown): DesktopClientPresentation {
  if (typeof value !== "object" || value === null) return { status: "unavailable" };
  const view = value as Record<string, unknown>;
  return desktopClientPresentationSchema.parse(
    view.status === "ready"
      ? { status: "ready", help: view.help, desktop: view.desktop }
      : { status: view.status },
  );
}
