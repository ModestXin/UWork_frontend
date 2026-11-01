import { useEffect } from "react";
import type { IUcasGatewayService } from "@zcode/services";
import { useEnterpriseIdentity } from "@/hooks/useEnterpriseIdentity.js";

/** UI fixture 的只读观察；沿用 main.tsx 的 deferred 门，不拥有认证状态。 */
export function createNativeRaceProbe(changed: () => void) {
  const facts = {
    nativeCloses: [] as string[],
    nativePending: false,
    gatewaySyncs: [] as string[],
    projectedStatuses: [] as string[],
    polls: 0,
  };
  return {
    facts,
    enterPoll() {
      facts.polls++;
      changed();
    },
    open(promise: Promise<string | null>) {
      facts.nativePending = true;
      changed();
      return promise.finally(() => {
        facts.nativePending = false;
        changed();
      });
    },
    close(id: string) {
      facts.nativeCloses.push(id);
      changed();
    },
    gateway: {
      sync: async (reason: string) => {
        facts.gatewaySyncs.push(reason);
        changed();
      },
    } as unknown as IUcasGatewayService,
    Launcher() {
      const identity = useEnterpriseIdentity();
      const status = identity?.view?.status ?? "unavailable";
      useEffect(() => {
        facts.projectedStatuses.push(status);
        changed();
      }, [status]);
      return (
        <>
          <button onClick={() => identity?.openLogin()}>打开登录</button>
          <button onClick={() => void identity?.logout()}>退出合成会话</button>
          <output data-testid="identity-status">{status}</output>
        </>
      );
    },
  };
}
