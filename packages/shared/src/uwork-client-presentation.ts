import { z } from "zod";
import {
  uworkPublishedFeatureSchema,
  uworkScenesConfigurationSchema,
  uworkHelpConfigurationSchema,
  uworkDesktopConfigurationSchema,
  uworkPluginStoreConfigurationSchema,
} from "./uwork-client-experience.js";

/** Validated display projections only; identity and publication remain Host-owned. */
export const uworkClientPresentationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unmanaged") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
  z
    .object({
      status: z.literal("ready"),
      version: z.number().int().nonnegative(),
      welcome: z.string().max(2000),
      riskNotice: z.string().min(1).max(2000),
      riskPrefix: z.string().min(1).max(2000),
      scenes: uworkPublishedFeatureSchema(uworkScenesConfigurationSchema),
      help: uworkPublishedFeatureSchema(uworkHelpConfigurationSchema),
      desktop: uworkPublishedFeatureSchema(uworkDesktopConfigurationSchema),
      pluginStore: uworkPublishedFeatureSchema(uworkPluginStoreConfigurationSchema),
    })
    .strict(),
]);
export type UWorkClientPresentation = z.infer<typeof uworkClientPresentationSchema>;
