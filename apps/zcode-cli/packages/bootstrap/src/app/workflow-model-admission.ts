import type { ModelRequestAdmission, ModelRequestAdmissionTicket } from "@zcode/contracts";
import type { WorkflowIoAdmission } from "./workflow-io-admission.js";

/** 保留并发票据 owner；原 run fence 在每个实际尝试和排队之后复核，不另造模型。 */
export function withWorkflowModelAdmission(
  scope: WorkflowIoAdmission,
  inner?: ModelRequestAdmission,
): ModelRequestAdmission | undefined {
  if (!scope.admission) return inner;
  return {
    // 企业裁决为异步，不能用同步 tryAcquire 绕过；没有快路径也不伪报排队。
    async acquire(input) {
      const signals = [scope.executionSignal, input.signal].filter(
        (value): value is AbortSignal => !!value,
      );
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      let ticket: ModelRequestAdmissionTicket | undefined;
      try {
        await scope.admission!.revalidate(signal);
        signal?.throwIfAborted();
        ticket =
          inner?.tryAcquire?.({ model: input.model }) ??
          (await inner?.acquire({ ...input, signal }));
        await scope.admission!.revalidate(signal);
        signal?.throwIfAborted();
        return ticket ?? { publish() {}, release() {} };
      } catch (error) {
        ticket?.release();
        throw error;
      }
    },
  };
}
