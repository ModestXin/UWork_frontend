import { z } from "zod";
import {
  uworkClientPresentationSchema,
  uworkScenesConfigurationSchema,
  uworkHelpConfigurationSchema,
  uworkDesktopConfigurationSchema,
  uworkPluginStoreConfigurationSchema,
  type UWorkPublishedFeature,
  type UWorkClientPresentation,
} from "@zcode/shared";
import type { UWorkBackendSession } from "./backendSessionContract.js";
import { UWorkBackendSessionError } from "./backendSessionContract.js";

const publishedSchema = z.object({
  tenantId: z.string().min(1).max(256),
  versions: z.object({ "new-chat": z.number().int().nonnegative() }).catchall(z.unknown()),
  configuration: z
    .object({
      "new-chat": z
        .object({
          welcome: z.string().max(2000),
          riskNotice: z.string().min(1).max(2000),
        })
        .strict(),
    })
    .catchall(z.unknown()),
  riskPrefix: z.string().min(1).max(2000),
});

function publishedFeature<T>(
  schema: z.ZodType<T>,
  data: unknown,
  version: unknown,
): UWorkPublishedFeature<T> {
  if (data === undefined && version === undefined) return { status: "unsupported" };
  if (data === undefined || version === undefined) return { status: "unavailable" };
  const parsed = schema.safeParse(data);
  return parsed.success &&
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 0
    ? { status: "ready", version, data: parsed.data }
    : { status: "unavailable" };
}

export interface ClientPresentationReadOptions {
  signal?: AbortSignal;
  /** Private turn metadata callers must not downgrade logout/cancellation into a disabled flag. */
  propagateInvalidation?: boolean;
}

export type ClientTurnPresentation =
  | { presentationStatus: "unmanaged" }
  | {
      presentationStatus: "ready" | "unsupported" | "unavailable";
      presentationSurface: "terminal" | "zcode_desktop";
    };

/** A private metadata projection; execution admission remains separate. */
export async function readClientTurnPresentation(
  read: (options?: ClientPresentationReadOptions) => Promise<UWorkClientPresentation>,
  signal?: AbortSignal,
): Promise<ClientTurnPresentation> {
  const view = await read({ signal, propagateInvalidation: true });
  if (view.status === "unmanaged") return { presentationStatus: "unmanaged" };
  if (view.status !== "ready")
    return { presentationStatus: "unavailable", presentationSurface: "terminal" };
  const feature = view.desktop;
  if (feature.status !== "ready")
    return { presentationStatus: feature.status, presentationSurface: "terminal" };
  return {
    presentationStatus: "ready",
    presentationSurface: feature.data.desktopContextPrompt.enabled ? "zcode_desktop" : "terminal",
  };
}

/** Stateless projection through the existing private identity scope, never an allow cache. */
export function createClientPresentationReader(backend: UWorkBackendSession) {
  return async (options?: ClientPresentationReadOptions): Promise<UWorkClientPresentation> => {
    try {
      options?.signal?.throwIfAborted();
      const result = await backend.run(
        async (scope) => {
          const response = await scope.request("/api/client/configuration");
          if (response.status !== 200) throw new Error("presentation_unavailable");
          const published = publishedSchema.parse(response.body);
          if (published.tenantId !== scope.tenantId)
            throw new UWorkBackendSessionError("enterprise_identity_changed");
          const projection = uworkClientPresentationSchema.parse({
            status: "ready",
            version: published.versions["new-chat"],
            ...published.configuration["new-chat"],
            riskPrefix: published.riskPrefix,
            scenes: publishedFeature(
              uworkScenesConfigurationSchema,
              published.configuration.scenes,
              published.versions.scenes,
            ),
            help: publishedFeature(
              uworkHelpConfigurationSchema,
              published.configuration.help,
              published.versions.help,
            ),
            desktop: publishedFeature(
              uworkDesktopConfigurationSchema,
              published.configuration.desktop,
              published.versions.desktop,
            ),
            pluginStore: publishedFeature(
              uworkPluginStoreConfigurationSchema,
              published.configuration["plugin-store"],
              published.versions["plugin-store"],
            ),
          });
          await scope.assertCurrent();
          options?.signal?.throwIfAborted();
          return projection;
        },
        { signal: options?.signal },
      );
      return result.managed ? result.value : { status: "unmanaged" };
    } catch (error) {
      options?.signal?.throwIfAborted();
      if (
        options?.propagateInvalidation &&
        error instanceof UWorkBackendSessionError &&
        (error.code === "enterprise_identity_changed" ||
          error.code === "enterprise_configuration_changed" ||
          error.code === "enterprise_authorization_cancelled")
      )
        throw error;
      return { status: "unavailable" };
    }
  };
}
