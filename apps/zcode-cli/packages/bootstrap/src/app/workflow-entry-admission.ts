import type { DynamicWorkflowRunSubmitOptions, WorkflowExecutionAdmission } from "@zcode/contracts";
import type { DynamicWorkflowRunEntryContext } from "./dynamic-workflow-run-submit.js";

export async function acquireWorkflowEntryAdmission(
  ctx: DynamicWorkflowRunEntryContext,
  options?: DynamicWorkflowRunSubmitOptions,
): Promise<WorkflowExecutionAdmission | undefined> {
  ctx.assertOpen();
  const cancellation = options?.signal
    ? AbortSignal.any([ctx.lifetimeSignal, options.signal])
    : ctx.lifetimeSignal;
  cancellation.throwIfAborted();
  const admission =
    options?.admission ??
    (await raceAdmission(
      Promise.resolve(ctx.deps.createExecutionAdmission?.(ctx.lifetimeSignal)),
      cancellation,
    ));
  await revalidateWorkflowEntry(ctx, admission, options?.signal);
  return admission;
}

export async function revalidateWorkflowEntry(
  ctx: DynamicWorkflowRunEntryContext,
  admission?: WorkflowExecutionAdmission,
  signal?: AbortSignal,
): Promise<void> {
  ctx.assertOpen();
  const cancellation = signal ? AbortSignal.any([ctx.lifetimeSignal, signal]) : ctx.lifetimeSignal;
  cancellation.throwIfAborted();
  await raceAdmission(Promise.resolve(admission?.revalidate(cancellation)), cancellation);
  cancellation.throwIfAborted();
  // close 只拥有既有注册表；新增 await 之后必须再查，不能在 close 后注册漏管 run。
  ctx.assertOpen();
}

function raceAdmission<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
