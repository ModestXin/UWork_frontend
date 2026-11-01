import { WorkflowError, type RunSettlement } from "@zcode/dynamic-workflow";

export async function checkHarnessAdmission(
  check: ((signal?: AbortSignal) => Promise<void>) | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (check) {
    const operation = check(signal);
    if (!signal) await operation;
    else
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
  }
  signal?.throwIfAborted();
}

export function harnessAdmissionError(cause: unknown): WorkflowError {
  const message =
    cause instanceof Error && /^enterprise_[a-z_]{1,80}$/.test(cause.message)
      ? cause.message
      : "enterprise_policy_unavailable";
  return new WorkflowError("DriverError", message);
}

export function abortedBeforeEngine(signal: AbortSignal): RunSettlement {
  const reason = signal.reason;
  const supersededBy =
    typeof reason === "object" &&
    reason !== null &&
    "superseded" in reason &&
    typeof reason.superseded === "string"
      ? reason.superseded
      : undefined;
  if (supersededBy) return { status: "stopped", reason: "superseded", supersededBy };
  return {
    status: "stopped",
    reason: reason === "model" ? "model" : reason === "interrupted" ? "interrupted" : "user",
  };
}
