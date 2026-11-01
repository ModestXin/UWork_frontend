import { useEffect, useRef } from "react";

export type WebBootstrapFailureKind = "bootstrap" | "disconnected";

/** 只管理本次 bootstrap 的渲染顺序；不重连、不保留或重放业务请求。 */
export async function connectWebBootstrap<T>(ports: {
  connect(onClose: () => void): Promise<T>;
  renderConnected(services: T): void;
  renderDisconnected(): void;
}): Promise<void> {
  let connected = false;
  let closed = false;
  const services = await ports.connect(() => {
    if (closed) return;
    closed = true;
    if (connected) ports.renderDisconnected();
  });
  connected = true;
  // open 的 Promise 已 resolve，但 close 可能先于本 continuation；旧 Root 不能晚到覆盖失败页。
  if (closed) ports.renderDisconnected();
  else ports.renderConnected(services);
}

export function WebBootstrapErrorScreen({
  kind,
  language,
  onRetry,
}: {
  kind: WebBootstrapFailureKind;
  language: string;
  onRetry(): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const chinese = /^zh\b/i.test(language);
  const disconnected = kind === "disconnected";
  useEffect(() => {
    heading.current?.focus();
  }, [kind]);
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section role="alert" className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 ref={heading} tabIndex={-1} className="text-ui-xs font-medium">
              {disconnected
                ? chinese
                  ? "连接已断开"
                  : "Connection lost"
                : chinese
                  ? "Web 启动失败"
                  : "Web bootstrap failed"}
            </h1>
          </div>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">
            {disconnected
              ? chinese
                ? "请重新连接后确认之前操作的结果。"
                : "Reconnect, then check the outcome of your previous operation."
              : chinese
                ? "无法连接到服务，请重试。"
                : "Unable to connect to the server. Please try again."}
          </p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={onRetry}
          >
            {chinese ? "重试" : "Retry"}
          </button>
        </section>
      </div>
    </div>
  );
}
