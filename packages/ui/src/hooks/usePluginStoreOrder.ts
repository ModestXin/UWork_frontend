import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginStoreOrder } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { useClientExperienceScope } from "./useClientExperienceScope.js";
import { currentClientExperienceValue } from "./clientExperienceScope.js";

/** 只持有当前身份的页面投影；Host facade 不保留另一份 accepted cache。 */
export function usePluginStoreOrder(enabled = true) {
  const { clientConfigService: service } = useServices();
  const scope = useClientExperienceScope("pluginStore");
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [snapshot, setSnapshot] = useState<{
    service: typeof service;
    scope: string;
    value: PluginStoreOrder | null;
  }>();
  const generation = useRef(0);
  const refresh = useCallback(
    async (forceRefresh = false) => {
      const current = ++generation.current;
      try {
        const { pluginStoreOrder: order } = await service.getSnapshot({ forceRefresh });
        if (generation.current === current && currentScope.current === scope)
          setSnapshot({ service, scope, value: order });
      } catch {
        if (generation.current === current && currentScope.current === scope) {
          setSnapshot({ service, scope, value: null });
          logger.warn("[PluginStoreOrder] 配置读取失败，清除失效的排序投影");
        }
      }
    },
    [scope, service],
  );

  useEffect(() => {
    if (enabled) void refresh();
    return () => {
      generation.current += 1;
    };
  }, [enabled, refresh]);

  return {
    order:
      enabled && snapshot?.service === service
        ? (currentClientExperienceValue(snapshot, scope) ?? null)
        : null,
    refresh,
  };
}
