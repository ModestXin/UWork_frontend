import { performance } from "node:perf_hooks";

type StartupPhase =
  | { phase: "lock-request-start" | "secondary-quit-start" }
  | { phase: "lock-request-return"; acquired: boolean; elapsedMs?: number }
  | { phase: "secondary-quit-return"; elapsedMs?: number };

type StartupLogger = { info: (...args: unknown[]) => unknown };

export function readSingleInstanceStartupTime(): number | undefined {
  try {
    const value = performance.now();
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    // 时钟只是诊断，失败不能阻断原持锁/退出调用，也不能伪造零耗时。
    return undefined;
  }
}

export function elapsedSingleInstanceStartupMs(start: number | undefined): number | undefined {
  const end = readSingleInstanceStartupTime();
  if (
    start === undefined ||
    end === undefined ||
    !Number.isFinite(start) ||
    start < 0 ||
    end < start
  ) {
    return undefined;
  }
  return end - start;
}

export function recordSingleInstanceStartupPhase(logger: StartupLogger, phase: StartupPhase): void {
  try {
    const details: {
      event: "desktop_single_instance_startup";
      phase: StartupPhase["phase"];
      acquired?: boolean;
      elapsedMs?: number;
    } = { event: "desktop_single_instance_startup", phase: phase.phase };
    if (phase.phase === "lock-request-return") details.acquired = phase.acquired;
    if (
      (phase.phase === "lock-request-return" || phase.phase === "secondary-quit-return") &&
      phase.elapsedMs !== undefined &&
      Number.isFinite(phase.elapsedMs) &&
      phase.elapsedMs >= 0
    ) {
      details.elapsedMs = phase.elapsedMs;
    }
    logger.info("[single-instance-startup]", details);
  } catch {
    // 原logger目录/console仍可同步抛错；新增观察日志不能改变原API返回或异常。
  }
}
