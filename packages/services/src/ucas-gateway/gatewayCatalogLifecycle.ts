import { Emitter, type Event } from "@zcode/rpc";
import type { GatewayIdentitySource, GatewayIdentityScope } from "./gatewayIdentityScope.js";
import type { UcasGatewayProvisioningTarget } from "./contract.js";

/** 仅Node装配可读的原Gateway目录lease；Symbol不会进入string RPC。 */
export const gatewayCatalogAuthority = Symbol("gateway-catalog-authority");
export interface GatewayCatalogAuthority {
  isCurrent(): boolean;
  readonly onDidChange: Event<void>;
}
export interface GatewayCatalogLifecycleAuthority extends GatewayCatalogAuthority {
  bindIdentityChanges(
    subscribe: NonNullable<GatewayIdentitySource["subscribeIdentityChanges"]>,
  ): void;
}

export function createGatewayCatalogLifecycle(
  options: GatewayIdentitySource & {
    provisioning: UcasGatewayProvisioningTarget;
    isProjectedCurrent(): boolean;
    hasManagedProjection(): boolean;
    invalidateProjection(): void;
    advance(): number;
    isCurrentGeneration(value: number): boolean;
    onClearFailure(): void;
  },
) {
  const changed = new Emitter<void>();
  let disposed = false;
  let unwatch: (() => void) | undefined;
  let watchedScope: GatewayIdentityScope | undefined;
  const notify = () => {
    if (!disposed) changed.fire();
  };
  const clear = async (generation: number) => {
    const issuer = watchedScope?.issuerOrigin;
    // abort 在 Identity 替换 controller/session 前同步触发；等原命令完成本轮内存失效。
    await Promise.resolve();
    const owner = options.readIdentityAuthority?.();
    if (!issuer || !owner || owner.session || owner.signal.aborted) return;
    const current = () => {
      const latest = options.readIdentityAuthority?.();
      return (
        !disposed &&
        options.isCurrentGeneration(generation) &&
        !!latest &&
        latest.generation === owner.generation &&
        latest.signal === owner.signal &&
        !latest.signal.aborted &&
        !latest.session
      );
    };
    const apiBaseUrl = await options.resolveApiBaseUrl();
    if (
      !apiBaseUrl ||
      new URL(apiBaseUrl).origin !== issuer ||
      (await options.resolveBackend?.()) !== "uwork" ||
      !current()
    )
      return;
    await options.provisioning.apply({
      baseUrl: new URL("/v1", apiBaseUrl).href,
      clearManagedCatalog: true,
      isCurrent: current,
    });
  };
  const invalidate = () => {
    if (disposed || !options.hasManagedProjection() || options.isProjectedCurrent()) return;
    const generation = options.advance();
    options.invalidateProjection();
    notify();
    void clear(generation).catch(() => {
      if (!disposed && options.isCurrentGeneration(generation)) options.onClearFailure();
    });
  };
  let identity = options.subscribeIdentityChanges?.(invalidate);
  return {
    authority: {
      isCurrent: () => !disposed && options.isProjectedCurrent(),
      onDidChange: changed.event,
      bindIdentityChanges(subscribe) {
        if (identity || disposed)
          throw Error("Gateway identity subscription already bound or disposed");
        identity = subscribe(invalidate);
      },
    } satisfies GatewayCatalogLifecycleAuthority,
    notify,
    watch(scope: GatewayIdentityScope) {
      unwatch?.();
      unwatch = undefined;
      watchedScope = scope;
      if (!scope.managed || !scope.signal) return;
      scope.signal.addEventListener("abort", invalidate, { once: true });
      unwatch = () => scope.signal?.removeEventListener("abort", invalidate);
    },
    dispose() {
      disposed = true;
      unwatch?.();
      identity?.dispose();
      changed.dispose();
    },
  };
}
