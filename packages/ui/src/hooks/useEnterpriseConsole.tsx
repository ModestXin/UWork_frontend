import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { IEnterpriseConsoleService } from "@zcode/services";
import { enterpriseNavigationSchema, type EnterpriseNavigation } from "@zcode/shared";
import { useEnterpriseIdentity } from "@/hooks/useEnterpriseIdentity.js";

interface ConsoleContext {
  service: IEnterpriseConsoleService | null;
  identityRevision: number | null;
  navigation: EnterpriseNavigation | null;
  managed: boolean;
  refreshNavigation(): void;
}
const Context = createContext<ConsoleContext>({
  service: null,
  identityRevision: null,
  navigation: null,
  managed: false,
  refreshNavigation() {},
});

/** Fixed base Host context; workspace-scoped ServiceProviders never replace this owner. */
export function EnterpriseConsoleProvider({
  service,
  children,
}: {
  service?: IEnterpriseConsoleService;
  children: ReactNode;
}) {
  const identity = useEnterpriseIdentity()?.view;
  const active = identity?.status === "authenticated" ? (service ?? null) : null;
  const revision = active ? (identity?.revision ?? null) : null;
  const [refresh, setRefresh] = useState(0);
  const [knownMode, setKnownMode] = useState<{
    service: IEnterpriseConsoleService;
    managed: boolean;
  } | null>(null);
  const [projection, setProjection] = useState<{
    service: IEnterpriseConsoleService;
    revision: number | null;
    value: EnterpriseNavigation;
  } | null>(null);
  const refreshNavigation = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void active
      .getNavigation()
      .then((value) => {
        if (current) {
          const parsed = enterpriseNavigationSchema.parse(value);
          setKnownMode({ service: active, managed: parsed.status !== "unmanaged" });
          setProjection({
            service: active,
            revision,
            value: parsed,
          });
        }
      })
      .catch(() => {
        if (current) setProjection({ service: active, revision, value: { status: "unavailable" } });
      });
    return () => {
      current = false;
    };
  }, [active, revision, refresh]);
  useEffect(() => {
    if (!active) return;
    window.addEventListener("focus", refreshNavigation);
    const timer = window.setInterval(refreshNavigation, 30000);
    return () => {
      window.removeEventListener("focus", refreshNavigation);
      window.clearInterval(timer);
    };
  }, [active, refreshNavigation]);
  const navigation =
    active && projection?.service === active && projection.revision === revision
      ? projection.value
      : null;
  return (
    <Context.Provider
      value={{
        service: active,
        identityRevision: revision,
        navigation,
        managed:
          !!service && (knownMode && knownMode.service === service ? knownMode.managed : !!active),
        refreshNavigation,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useEnterpriseConsole() {
  return useContext(Context);
}
