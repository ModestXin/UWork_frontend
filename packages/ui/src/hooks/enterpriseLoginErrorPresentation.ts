import type { EnterpriseIdentityAttempt, EnterpriseIdentityView } from "@zcode/shared";

/** 仅初始化窗口句柄；每个 owner 一份，不保存第二份认证 view，也不执行 IO。 */
export function createEnterpriseLoginOperations(changed: () => void) {
  return {
    errors: createEnterpriseLoginErrorPresentation(changed),
    nativeAttemptId: null as string | null,
    pendingStart: null as Promise<EnterpriseIdentityAttempt> | null,
    startCancellation: Promise.resolve(),
    activeAttemptId: null as string | null,
    surfaceController: null as AbortController | null,
  };
}

type Intent = "clear" | "selection" | "admission" | "logout";
type Operation = { ticket: number; kind: Intent | "initial" | "starting" | "attempt"; id?: string };

/** 窗口提示不是 Host 诊断：用户清除后，组织 republish 的旧 failed 不能复活提示。 */
export function createEnterpriseLoginErrorPresentation(changed: () => void) {
  let operation: Operation = { ticket: 0, kind: "initial" };
  let visible = false;
  let revision = -1;
  let observed: { id: string; failed: boolean } | null = null;
  const show = (next: boolean) => {
    if (visible === next) return;
    visible = next;
    changed();
  };
  const begin = (kind: Intent) => {
    operation = { ticket: operation.ticket + 1, kind };
    observed = null;
    if (kind !== "selection") show(false);
    return operation.ticket;
  };
  return {
    get visible() {
      return visible;
    },
    get ticket() {
      return operation.ticket;
    },
    isCurrent(ticket: number) {
      return operation.ticket === ticket;
    },
    begin,
    admit(ticket: number) {
      if (operation.ticket !== ticket || operation.kind !== "admission") return;
      operation = { ticket, kind: "starting" };
      // 原取消屏障内观察到的旧 start 不能归入新一次 begin。
      observed = null;
    },
    bind(ticket: number, id: string) {
      if (operation.ticket !== ticket || operation.kind !== "starting") return false;
      operation = { ticket, kind: "attempt", id };
      const failed = observed?.id === id && observed.failed;
      if (failed) show(true);
      return failed;
    },
    fail(ticket: number) {
      if (operation.ticket === ticket) show(true);
    },
    succeed(ticket: number) {
      if (operation.ticket === ticket) begin("clear");
    },
    observe(view: EnterpriseIdentityView) {
      if (view.revision <= revision) return;
      revision = view.revision;
      if (view.status === "authenticated") {
        begin("clear");
      } else if (view.status === "waiting") {
        if (observed?.id !== view.pending.id) observed = { id: view.pending.id, failed: false };
      } else if (view.error === "failed") {
        // Host 先发 waiting→failed、后返回 begin ID 时，保留同 ID 失败供实际绑定追认。
        // failed 的重发不清掉这条短命关联；低 revision 已在上方拒绝。
        if (observed) observed.failed = true;
        if (
          operation.kind === "initial" ||
          (operation.kind === "attempt" && observed?.id === operation.id)
        )
          show(true);
      } else {
        observed = null;
      }
    },
  };
}
