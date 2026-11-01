import { useCallback, useEffect, useRef, useState } from "react";
import type { IUcasGatewayService } from "@zcode/services";
import {
  ucasGatewayViewSchema,
  type UcasGatewaySyncResult,
  type UcasGatewayUsageMetric,
  type UcasGatewayUsagePeriod,
  type UcasGatewayView,
} from "@zcode/shared";
import { useOptionalBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface UcasGatewayController {
  /** 当前 Host 是否注册了企业网关服务。 */
  available: boolean;
  view: UcasGatewayView | null;
  busy: boolean;
  period: UcasGatewayUsagePeriod;
  metric: UcasGatewayUsageMetric;
  sync(): Promise<UcasGatewaySyncResult | null>;
  setPeriod(period: UcasGatewayUsagePeriod): void;
  setMetric(metric: UcasGatewayUsageMetric): void;
  refreshUsage(force: boolean): Promise<void>;
  refreshModels(): Promise<void>;
  applyModels(): Promise<void>;
  replaceApiKey(): Promise<void>;
}

interface UsageSelection {
  period: UcasGatewayUsagePeriod;
  metric: UcasGatewayUsageMetric;
}

interface GatewayUiBinding {
  service: IUcasGatewayService | null;
  view: UcasGatewayView | null;
  operation: number | null;
  pendingSelection: UsageSelection | null;
}

function emptyBinding(service: IUcasGatewayService | null): GatewayUiBinding {
  return { service, view: null, operation: null, pendingSelection: null };
}

/**
 * 企业网关视图的唯一 UI 绑定：订阅 Host 事件并提交权威快照，
 * 组件不直接持有凭据或自行推断同步结果。
 */
export function useUcasGateway(): UcasGatewayController {
  // 企业网关是设备级事实（与身份同源），必须读 base host；远端 workspace 的
  // ServiceProvider 不能替换它，否则面板会指向远端 Host 的空状态。
  const services = useOptionalBaseWorkspaceServices();
  const service: IUcasGatewayService | null = services?.ucasGatewayService ?? null;
  const [binding, setBinding] = useState<GatewayUiBinding>(() => emptyBinding(service));
  const serviceRef = useRef(service);
  const generation = useRef(0);
  // service 更换的 render 当帧隐藏旧资料和 overlay，不等待 effect 才清空。
  const visible = binding.service === service ? binding : emptyBinding(service);
  const view = visible.view;

  const commitView = useCallback(
    (candidate: unknown): void => {
      if (serviceRef.current !== service) return;
      const parsed = ucasGatewayViewSchema.safeParse(candidate);
      if (!parsed.success) {
        logger.warn("UCAS gateway view projection rejected an invalid payload");
        return;
      }
      const next = parsed.data;
      setBinding((current) => {
        if (current.service !== service) return current;
        const previous = current.view;
        // RPC 返回和事件可交错；同一 service 的旧 View 不能复活已撤销投影。
        if (previous && next.revision < previous.revision) return current;
        const sameOwner =
          previous?.authMode === next.authMode &&
          previous?.user?.id === next.user?.id &&
          previous?.user?.orgId === next.user?.orgId;
        // 只退休 UI overlay，不创建身份 authority。空态即使被 React 批处理也必须生效。
        const retireSelection = !sameOwner || next.usage === null;
        // 冷启动 idle→syncing 的 usage 同样为空，不能提前结束合法同步的 busy。
        const retireOperation =
          next.status === "signed-out" || (previous?.user != null && !sameOwner);
        const pending = current.pendingSelection;
        const echoed =
          pending?.period === next.usage?.period && pending?.metric === next.usage?.metric;
        return {
          ...current,
          view: next,
          operation: retireOperation ? null : current.operation,
          pendingSelection: retireSelection || echoed ? null : pending,
        };
      });
    },
    [service],
  );

  useEffect(() => {
    // 只在已提交的 effect 换绑定，废弃 render 不能关掉仍可见 service 的提交口。
    serviceRef.current = service;
    generation.current++;
    // 新 service 有独立 revision 域，不能继承旧 service 的水位或 busy。
    setBinding(emptyBinding(service));
    if (!service) return;
    let active = true;
    const apply = (candidate: unknown) => {
      if (active) commitView(candidate);
    };
    const subscription = service.onDidChange(apply);
    void service
      .getView()
      .then(apply)
      .catch(() => {
        if (active) logger.warn("UCAS gateway view could not be loaded");
      });
    return () => {
      active = false;
      generation.current++;
      subscription.dispose();
    };
  }, [service, commitView]);

  const startOperation = useCallback(
    (selection: UsageSelection | null): number => {
      const operation = ++generation.current;
      setBinding((current) =>
        current.service === service
          ? { ...current, operation, pendingSelection: selection }
          : current,
      );
      return operation;
    },
    [service],
  );

  const finishOperation = useCallback(
    (operation: number): void => {
      if (serviceRef.current !== service || generation.current !== operation) return;
      // 旧 finally 只能结束自己的 overlay，不能清理新 service 或新请求。
      setBinding((current) =>
        current.service === service && current.operation === operation
          ? { ...current, operation: null, pendingSelection: null }
          : current,
      );
    },
    [service],
  );

  const run = useCallback(
    async (
      operation: () => Promise<unknown>,
      selection: UsageSelection | null = null,
    ): Promise<void> => {
      if (!service || serviceRef.current !== service) return;
      const current = startOperation(selection);
      try {
        const result = await operation();
        // 用量返回可能先于对应事件；同一提交口保证周期回显与 revision 一致。
        if (selection && generation.current === current) commitView(result);
      } catch {
        // 服务已把失败写入 View；这里只记录本地异常，不复制可能含诊断的详情。
        logger.warn("UCAS gateway operation failed");
      } finally {
        finishOperation(current);
      }
    },
    [service, startOperation, finishOperation, commitView],
  );

  const sync = useCallback(async (): Promise<UcasGatewaySyncResult | null> => {
    if (!service || serviceRef.current !== service) return null;
    const current = startOperation(null);
    try {
      const result = await service.sync("manual");
      if (generation.current === current) commitView(result.view);
      return result;
    } catch {
      logger.warn("UCAS gateway sync failed");
      return null;
    } finally {
      finishOperation(current);
    }
  }, [service, startOperation, finishOperation, commitView]);

  // 本地仅保留当前在途操作的视觉选择，已结束或失效后直接读取 Host 的 View。
  const period = visible.pendingSelection?.period ?? view?.usage?.period ?? "month";
  const metric = visible.pendingSelection?.metric ?? view?.usage?.metric ?? "requests";
  const requestUsage = useCallback(
    (next: UsageSelection, force: boolean) =>
      service ? run(() => service.refreshUsage({ ...next, force }), next) : Promise.resolve(),
    [service, run],
  );
  const refreshUsage = useCallback(
    (force: boolean) => requestUsage({ period, metric }, force),
    [requestUsage, period, metric],
  );

  return {
    available: service !== null,
    view,
    busy: visible.operation !== null,
    period,
    metric,
    sync,
    setPeriod: (next) => void requestUsage({ period: next, metric }, false),
    setMetric: (next) => void requestUsage({ period, metric: next }, false),
    refreshUsage,
    refreshModels: () => (service ? run(() => service.refreshModels()) : Promise.resolve()),
    applyModels: () => (service ? run(() => service.applyModels()) : Promise.resolve()),
    replaceApiKey: () => (service ? run(() => service.replaceApiKey()) : Promise.resolve()),
  };
}
