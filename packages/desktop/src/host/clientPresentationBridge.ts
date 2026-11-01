import {
  projectDesktopClientPresentation,
  type HostClientPresentationResponse,
} from "@zcode/shared";

/** 只绑定既有 identity getter；计数用于弃旧，不保存配置或身份事实。 */
export function createHostClientPresentationBridge(options: {
  identity: {
    readClientPresentation(): Promise<unknown>;
    onDidChange(listener: () => void): (() => void) | { dispose(): void };
  };
  publish(message: HostClientPresentationResponse): void;
  nextSourceEpoch?: () => number;
}) {
  let sourceEpoch = options.nextSourceEpoch?.() ?? 0;
  let disposed = false;
  const subscription = options.identity.onDidChange(() => {
    if (disposed) return;
    sourceEpoch = options.nextSourceEpoch?.() ?? sourceEpoch + 1;
    options.publish({ type: "client-presentation-invalidated", sourceEpoch });
  });
  return {
    async read(requestId: string): Promise<void> {
      const captured = sourceEpoch;
      let projection;
      try {
        projection = projectDesktopClientPresentation(
          await options.identity.readClientPresentation(),
        );
      } catch {
        projection = { status: "unavailable" as const };
      }
      if (disposed || captured !== sourceEpoch) return;
      options.publish({ type: "client-presentation-result", requestId, sourceEpoch, projection });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sourceEpoch = options.nextSourceEpoch?.() ?? sourceEpoch + 1;
      options.publish({ type: "client-presentation-invalidated", sourceEpoch });
      if (typeof subscription === "function") subscription();
      else subscription.dispose();
    },
  };
}
