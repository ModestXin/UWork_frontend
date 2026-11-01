import type { AgentRuntimeDeps, AgentRuntimeConfig } from "../types.js";
import type { TraceContext } from "../deps.js";

/** 在原 reservation 后捕获一次；配置来源是私有 port，不是 prompt/磁盘自报字段。 */
export async function applyTurnPresentation(
  runtime: {
    config: AgentRuntimeConfig;
    turnPresentationPort?: AgentRuntimeDeps["turnPresentationPort"];
  },
  signal: AbortSignal,
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.turnPresentationPort) return;
  signal.throwIfAborted();
  const surface = await runtime.turnPresentationPort.read({ signal, traceContext });
  signal.throwIfAborted();
  if (surface !== undefined) runtime.config.presentationSurface = surface;
}
