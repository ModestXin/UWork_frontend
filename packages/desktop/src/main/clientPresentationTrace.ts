import {
  DISABLED_RENDERER_ACTION_TRACE_CONFIG,
  rendererActionTraceBatchSchema,
  type RendererActionTraceConfigV1,
} from "@zcode/shared";
import type { BoundClientPresentation } from "./clientPresentationBindings.js";

const truthy = (value: string | undefined) => /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? "");

/** 本机诊断不是 managed tracking 的授权来源。 */
export function resolveBoundRendererTraceConfig(
  bound: BoundClientPresentation,
  env: Record<string, string | undefined>,
): RendererActionTraceConfigV1 {
  const base = {
    ...DISABLED_RENDERER_ACTION_TRACE_CONFIG,
    bindingEpoch: bound.bindingEpoch,
    ...(truthy(env.ZCODE_LOCAL_TTFT_ENABLED) ? { localTtftEnabled: true } : {}),
  };
  const projection = bound.projection;
  if (projection.status === "ready" && projection.desktop.status === "ready")
    return {
      ...base,
      ...projection.desktop.data.rendererActionTrace,
      configVersion: `desktop:${projection.desktop.version}`,
    };
  if (projection.status === "unmanaged" && truthy(env.ZCODE_RENDERER_ACTION_TRACE_ENABLED))
    return {
      ...base,
      enabled: true,
      sampleRatio: 1,
      enabledGroups: ["core", "settings"],
      configVersion: "local-explicit",
    };
  return base;
}

export function authorizeRendererTraceBatch(
  batch: unknown,
  config: RendererActionTraceConfigV1,
): boolean {
  const parsed = rendererActionTraceBatchSchema.safeParse(batch);
  return (
    parsed.success &&
    config.enabled &&
    config.sampleRatio > 0 &&
    config.bindingEpoch !== undefined &&
    parsed.data.bindingEpoch === config.bindingEpoch &&
    parsed.data.spans.every((span) => config.enabledGroups.includes(span.attributes.catalog_group))
  );
}
