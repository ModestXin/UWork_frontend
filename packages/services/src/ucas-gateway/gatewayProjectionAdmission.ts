import type {
  GatewayIdentityScope,
  GatewayIdentitySource,
  createGatewayIdentityScopeFactory,
} from "./gatewayIdentityScope.js";
import { isGatewayProjectionCurrent, createScopedGatewayClient } from "./gatewayIdentityScope.js";
import type { UcasGatewayClient, UcasGatewayClientOptions } from "./ucasGatewayClient.js";
import type { UcasGatewayView } from "@zcode/shared";
import { recoveredGatewayProjection } from "./gatewayViewProjection.js";
import {
  clearRejectedGatewayCatalog,
  isGatewayAuthorizationRejection,
  stageEmptyGatewayCatalog,
} from "./gatewayProvisioningReads.js";
import type { UcasGatewayProvisioningTarget } from "./contract.js";

export interface GatewayProjectionScope extends GatewayIdentityScope {
  readonly identityScope: GatewayIdentityScope;
  isAdmitted(): boolean;
}

/** 读取仍由原Gateway owner提供当前视图/scope；这里只复用一次操作的准入顺序。 */
export function createGatewayReadOperation(options: {
  source: GatewayIdentitySource & Pick<UcasGatewayClientOptions, "fetchImpl" | "timeoutMs">;
  hydrate(): Promise<void>;
  readView(): UcasGatewayView;
  readScope(): GatewayIdentityScope | null;
  signedOut(): void;
  clearProjection(scope?: GatewayIdentityScope): void;
  publish(view: Omit<UcasGatewayView, "revision">): void;
  createScope: ReturnType<typeof createGatewayIdentityScopeFactory>;
  admission: ReturnType<typeof createGatewayProjectionAdmission>;
}) {
  return async (
    operation: (client: UcasGatewayClient, scope: GatewayProjectionScope) => Promise<void>,
    isCurrent: () => boolean = () => true,
  ): Promise<UcasGatewayView> => {
    await options.hydrate();
    const session = await options.source.readIdentitySession();
    const apiBaseUrl = session ? await options.source.resolveApiBaseUrl() : undefined;
    if (!session || !apiBaseUrl) {
      if (!session) options.signedOut();
      return structuredClone(options.readView());
    }
    const backend = (await options.source.resolveBackend?.()) ?? "ucas";
    let scope: GatewayProjectionScope | undefined;
    try {
      scope = options.admission.bind(options.createScope(session, apiBaseUrl, backend));
      await scope.assertCurrent();
      if (
        scope.managed &&
        !(await isGatewayProjectionCurrent(
          options.readScope(),
          options.readView().endpoint?.baseUrl,
          apiBaseUrl,
        ))
      ) {
        if (!scope.isCurrent()) throw new Error("Gateway projection admission changed");
        options.clearProjection(scope.identityScope);
      }
      const client = createScopedGatewayClient(options.source, session, apiBaseUrl, backend, scope);
      await operation(client, scope);
      await scope.assertCurrent();
      if (!isCurrent()) return structuredClone(options.readView());
      const view = options.readView();
      if (view.error !== null)
        options.publish(recoveredGatewayProjection(view, backend === "uwork"));
    } catch (error) {
      if (scope && !scope.isAdmitted()) return structuredClone(options.readView());
      if (backend === "uwork" && (!scope || !scope.isCurrent())) options.clearProjection(scope);
      else if (isCurrent()) await options.admission.fail(error, scope, apiBaseUrl, backend, true);
    }
    return structuredClone(options.readView());
  };
}
/** Gateway内部投影顺序器；只有数字代次，身份仍全部由原identity lease提供。 */
export function createGatewayProjectionAdmission(options: {
  provisioning: UcasGatewayProvisioningTarget;
  clearProjection(scope?: GatewayIdentityScope): void;
  publishFailure(error: unknown, backend: string, partial: boolean): void;
  onRejection(): void;
  onClearFailure(): void;
}) {
  let generation = 0;
  const bind = (
    identityScope: GatewayIdentityScope,
    captured = generation,
  ): GatewayProjectionScope => {
    const isAdmitted = () => !identityScope.managed || captured === generation;
    const check = () => {
      if (!isAdmitted()) throw new Error("Gateway projection admission changed");
    };
    return {
      ...identityScope,
      identityScope,
      isAdmitted,
      isCurrent: () => isAdmitted() && identityScope.isCurrent(),
      async assertCurrent() {
        check();
        await identityScope.assertCurrent();
        check();
      },
    };
  };
  return {
    advance: () => ++generation,
    isCurrent: (captured: number) => captured === generation,
    bind,
    async prepare(
      scope: GatewayProjectionScope,
      projected: GatewayIdentityScope | null,
      endpoint: string | undefined,
      apiBaseUrl: string,
    ) {
      await scope.assertCurrent();
      if (scope.managed && !(await isGatewayProjectionCurrent(projected, endpoint, apiBaseUrl))) {
        if (!scope.isCurrent()) throw new Error("Gateway projection admission changed");
        options.clearProjection(scope.identityScope);
        await stageEmptyGatewayCatalog(options.provisioning, scope, apiBaseUrl);
      }
      await scope.assertCurrent();
    },
    async fail(
      error: unknown,
      initial: GatewayProjectionScope | undefined,
      apiBaseUrl: string,
      backend: string,
      partial = false,
    ) {
      let scope = initial,
        rejected = false;
      // 过时失败不能清新快照，也不能让旧clear在新fullsync后落盘。
      if (scope && !scope.isAdmitted()) return;
      if (scope?.managed && scope.isCurrent() && isGatewayAuthorizationRejection(error)) {
        generation++;
        options.onRejection();
        scope = bind(scope.identityScope);
        // 已知拒绝立即撤投影，不让磁盘候选清理等待期间仍公开ready。
        options.publishFailure(error, backend, partial);
        rejected = true;
      }
      await clearRejectedGatewayCatalog(options.provisioning, scope, apiBaseUrl, error).catch(
        () => {
          if (scope?.isCurrent()) options.onClearFailure();
        },
      );
      if (scope && !scope.isAdmitted()) return;
      if (backend === "uwork" && (!scope || !scope.isCurrent()))
        options.clearProjection(scope?.identityScope);
      else if (!rejected) options.publishFailure(error, backend, partial);
    },
  };
}
