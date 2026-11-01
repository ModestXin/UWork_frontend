import { randomUUID } from "node:crypto";
import type { EnterpriseIdentityView } from "@zcode/shared";
import type { IEnterpriseIdentityService } from "../enterprise-identity/contract.js";
import type { EnterpriseIdentityAuthority } from "../enterprise-identity/identityServiceLifecycle.js";
import type { EnterpriseAssetsHost } from "./hostContract.js";

export function attachEnterpriseAssetsLifecycle(options: {
  identity: Pick<IEnterpriseIdentityService, "getView" | "onDidChange">;
  assets: EnterpriseAssetsHost;
  readAuthority: () => EnterpriseIdentityAuthority | undefined;
  onDiagnostic?: (event: { traceId: string; code: string }) => void;
}) {
  let disposed = false;
  let warmup: { generation: number; task: Promise<unknown> } | undefined;
  const report = (traceId: string, code: string) => {
    try {
      if (!disposed) options.onDiagnostic?.({ traceId, code });
    } catch {
      /* 日志出口不改变身份或文件状态。 */
    }
  };
  const changed = (view: EnterpriseIdentityView) => {
    try {
      if (disposed) return;
      const authority = options.readAuthority();
      if (!authority) return;
      const generation = authority.generation,
        traceId = randomUUID();
      if (view.status === "authenticated" && authority.session && !authority.signal.aborted) {
        if (warmup?.generation === generation) return;
        const task = options.assets
          .readCatalog(traceId)
          .then((catalog) => {
            if (catalog.status === "denied") report(traceId, catalog.code);
          })
          .catch(() => report(traceId, "enterprise_assets_unavailable"));
        warmup = { generation, task };
        void task
          .finally(() => {
            if (warmup?.task === task) warmup = undefined;
          })
          .catch(() => {});
      } else if (view.status === "signed-out" && authority.session === null) {
        void options.assets
          .clearCached({
            traceId,
            isCurrent: () => {
              const current = options.readAuthority();
              return !disposed && current?.generation === generation && current.session === null;
            },
          })
          .catch(() => report(traceId, "enterprise_asset_cleanup_unconfirmed"));
      }
    } catch {
      report(randomUUID(), "enterprise_identity_unavailable");
    }
  };
  const subscription = options.identity.onDidChange(changed);
  void options.identity
    .getView()
    .then(changed)
    .catch(() => report(randomUUID(), "enterprise_identity_unavailable"));
  return {
    async disposeAllAndWait() {
      disposed = true;
      subscription.dispose();
      await options.assets.disposeAllAndWait();
    },
  };
}
