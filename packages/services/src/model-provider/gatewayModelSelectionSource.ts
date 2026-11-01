import type {
  ProviderRegistryFacadeSource,
  ProviderRegistryServiceSnapshot,
  ProviderRegistryView,
} from "@zcode/provider";
import type { GatewayCatalogAuthority } from "../ucas-gateway/gatewayCatalogLifecycle.js";

/** 只投影原Registry，不保存目录/身份/授权值；Provider实例和原选型算法保持唯一。 */
export function createGatewayModelSelectionSource(base: ProviderRegistryFacadeSource) {
  let authority: GatewayCatalogAuthority | undefined;
  let subscription: { dispose(): void } | undefined;
  const invalidated = new Set<() => void>();
  const changed = new Set<() => void>();
  const managed = (provider: ProviderRegistryView["providers"][number]) =>
    provider.providerId === "ucas" && provider.config.access?.type === "enterprise-session";
  const admitted = () => {
    try {
      return !authority || authority.isCurrent();
    } catch {
      return false;
    }
  };
  const view = (value: ProviderRegistryView): ProviderRegistryView =>
    admitted()
      ? value
      : Object.freeze({
          revision: value.revision,
          providers: Object.freeze(value.providers.filter((provider) => !managed(provider))),
        });
  const snapshot = (value: ProviderRegistryServiceSnapshot): ProviderRegistryServiceSnapshot => {
    const registry = view(value.registry);
    return registry === value.registry ? value : Object.freeze({ ...value, registry });
  };
  const source: ProviderRegistryFacadeSource = {
    getSnapshot: () => {
      const value = base.getSnapshot();
      return value ? snapshot(value) : null;
    },
    getView: () => view(base.getView()),
    refresh: async (reason) => {
      const value = await base.refresh(reason);
      return snapshot(base.getSnapshot() ?? value);
    },
    onDidChange(listener) {
      const emit = () => {
        const current = source.getSnapshot();
        if (current) listener({ snapshot: current, reasons: ["gateway-catalog-admission"] });
      };
      changed.add(emit);
      const dispose = base.onDidChange((event) =>
        listener({ ...event, snapshot: snapshot(event.snapshot) }),
      );
      return () => {
        dispose();
        changed.delete(emit);
      };
    },
  };
  const notify = () => {
    if (!admitted() && base.getView().providers.some(managed))
      for (const listener of invalidated) listener();
    for (const listener of changed) listener();
  };
  return {
    source,
    onDidInvalidate(listener: () => void) {
      invalidated.add(listener);
      return () => invalidated.delete(listener);
    },
    bind(value: GatewayCatalogAuthority) {
      if (authority) throw Error("Gateway catalog authority already bound");
      authority = value;
      subscription = authority.onDidChange(notify);
      notify();
    },
    dispose() {
      subscription?.dispose();
      invalidated.clear();
      changed.clear();
    },
  };
}
