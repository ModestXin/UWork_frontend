import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  IEnterpriseIdentityService,
  IProviderSettingsService,
  IUcasGatewayService,
} from "@zcode/services";
import {
  enterpriseIdentityAttemptSchema,
  enterpriseIdentityCompletionSchema,
  enterpriseLoginRequestSchema,
  enterpriseIdentityViewSchema,
  type EnterpriseIdentityView,
  type EnterpriseLoginSurface,
  type UWorkClientPresentation,
} from "@zcode/shared";
import { useEnterpriseIdentityStore } from "@/store/enterpriseIdentityStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { EnterpriseLoginPage } from "@/login/EnterpriseLoginPage.js";
import { UcasApiKeyDialog } from "@/login/UcasApiKeyDialog.js";
import { shouldRequestUcasApiKey } from "@/login/ucasApiKeyPrompt.js";
import { logger } from "@/logger.js";
import { createEnterpriseLoginSurfaceGate } from "./enterpriseLoginSurfaceGate.js";
import { useClientPresentation } from "./useClientPresentation.js";
import { createEnterpriseLoginOperations } from "./enterpriseLoginErrorPresentation.js";

const warnCancellation = () => logger.warn("Enterprise login cancellation failed");

interface IdentityContextValue {
  view: EnterpriseIdentityView | null;
  presentation: UWorkClientPresentation | null;
  allowLogin: boolean;
  openLogin(): void;
  logout(): Promise<void>;
  /** 配置里的可选组织（多公司时登录卡片展示选择器）。 */
  organizations: EnterpriseIdentityView["organizations"];
  selectedOrgId: string | null;
  /** 组织展示名（label 优先）；传入的身份组织不在清单内时返回 null。 */
  organizationLabel(orgId: string): string | null;
  selectOrganization(orgId: string): Promise<void>;
}
const IdentityContext = createContext<IdentityContextValue | null>(null);

/** 固定绑定应用 base services，嵌套远端 ServiceProvider 不会替换身份 owner。 */
export function EnterpriseIdentityProvider({
  service,
  providerSettingsService,
  ucasGatewayService,
  showOnStartup,
  allowLogin = true,
  children,
}: {
  service?: IEnterpriseIdentityService;
  providerSettingsService: Pick<IProviderSettingsService, "refresh" | "setUcasApiKeyIfMissing">;
  /** 企业网关自动配置；旧 Host 或只读 attachment 不提供。 */
  ucasGatewayService?: IUcasGatewayService;
  showOnStartup: boolean;
  allowLogin?: boolean;
  children: ReactNode;
}) {
  const platform = usePlatform();
  const owner = service ?? null;
  const view = useEnterpriseIdentityStore((state) => (state.owner === owner ? state.view : null));
  const presentation = useClientPresentation(owner, view);
  const [open, setOpen] = useState(showOnStartup);
  const [busy, setBusy] = useState(false);
  const [, refreshError] = useState(0);
  const [showUcasApiKeyPrompt, setShowUcasApiKeyPrompt] = useState(false);
  const actionGeneration = useRef(0);
  // 本窗口异步句柄随 owner 一起更换；B 不能等待 A 的屏障或用 B 取消 A 的 ID。
  // A 的旧闭包仍持有原句柄，迟到 begin 会沿原 owner 完成精确取消。
  const operations = useMemo(
    () => createEnterpriseLoginOperations(() => refreshError((value) => value + 1)),
    [owner],
  );
  const errors = operations.errors;
  const projectView = useCallback(
    (candidate: EnterpriseIdentityView) => {
      errors.observe(candidate);
      if (owner) useEnterpriseIdentityStore.getState().project(owner, candidate);
    },
    [owner, errors],
  );
  // 无 ID 的启动也属于本窗口：返回后先结算并取消旧启动，再放行下一次登录。
  const cancelPendingStart = useCallback(() => {
    const pending = operations.pendingStart;
    if (!pending || !owner) return;
    const cancellation = pending.then(
      (attempt) => owner.cancelLogin(attempt.id),
      () => {},
    );
    operations.startCancellation = cancellation;
    // 只记录失败，不把失败屏障转换为成功，否则下一次仍会复用未取消的启动。
    void cancellation.catch(warnCancellation);
  }, [owner, operations]);
  const gatewaySyncRef = useRef<string | null>(null);
  const [surfaceGate] = useState(createEnterpriseLoginSurfaceGate);
  const closeSurface = useCallback(() => {
    operations.surfaceController?.abort();
    operations.surfaceController = null;
    if (operations.nativeAttemptId) platform.cancelEnterpriseLogin?.(operations.nativeAttemptId);
    operations.nativeAttemptId = null;
  }, [platform, operations]);
  const onSurface = useCallback(
    (surface: EnterpriseLoginSurface | null) => {
      surfaceGate.publish(surface);
      if (operations.nativeAttemptId)
        platform.updateEnterpriseLogin?.({ id: operations.nativeAttemptId, surface });
    },
    [platform, surfaceGate, operations],
  );

  useEffect(() => {
    const store = useEnterpriseIdentityStore.getState();
    store.attach(owner);
    setBusy(false);
    let active = true;
    const apply = (candidate: unknown) => {
      if (!active || !owner) return;
      const parsed = enterpriseIdentityViewSchema.safeParse(candidate);
      if (!parsed.success) {
        errors.fail(errors.ticket);
        return;
      }
      projectView(parsed.data);
    };
    if (!owner) return;
    // 先订阅，再读取；revision 防止慢快照覆盖更新的认证事件。
    const subscription = owner.onDidChange(apply);
    const restoreGeneration = actionGeneration.current;
    const restoreTicket = errors.ticket;
    void (allowLogin ? owner.restoreSession() : owner.getView()).then(apply).catch(() => {
      // 跳过或重新发起登录后，旧恢复失败不能污染新登录页的错误状态。
      if (active && actionGeneration.current === restoreGeneration) {
        errors.fail(restoreTicket);
        logger.warn("Enterprise identity restore failed");
      }
    });
    return () => {
      active = false;
      actionGeneration.current++;
      errors.begin("clear");
      closeSurface();
      const attemptId = operations.activeAttemptId;
      operations.activeAttemptId = null;
      if (attemptId) void owner.cancelLogin(attemptId).catch(warnCancellation);
      subscription.dispose();
    };
  }, [owner, allowLogin, errors, projectView, closeSurface]);

  useEffect(() => {
    if (view?.status === "authenticated") {
      operations.activeAttemptId = null;
      setOpen(false);
      setBusy(false);
    } else {
      setShowUcasApiKeyPrompt(false);
    }
    if (view?.status !== "waiting" && operations.surfaceController) {
      actionGeneration.current++;
      closeSurface();
      setBusy(false);
    }
  }, [view?.status, operations, closeSurface]);

  useEffect(() => {
    if (!ucasGatewayService || !allowLogin) return;
    if (view?.status !== "authenticated" || !view.profile) {
      gatewaySyncRef.current = null;
      return;
    }
    // 每个已认证身份只自动同步一次；失败后由面板的「同步」按钮显式重试。
    const identityKey = `${view.profile.tenantId}:${view.profile.id}`;
    if (gatewaySyncRef.current === identityKey) return;
    gatewaySyncRef.current = identityKey;
    void ucasGatewayService.sync("startup");
  }, [ucasGatewayService, allowLogin, view?.status, view?.profile?.id, view?.profile?.tenantId]);

  useEffect(() => {
    // 轮询与内嵌扫码并行：企业微信桌面端把回调交给系统浏览器时，窗口内永远等不到
    // 一次性 code，只能靠 Host 的握手轮询认领会话；窗口内回调路径仍由 completeLogin 结算。
    if (!owner || !allowLogin || view?.status !== "waiting") return;
    const pollGeneration = actionGeneration.current;
    const pollTicket = errors.ticket;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const candidate = await owner.pollLogin(view.pending.id);
        if (!active) return;
        projectView(enterpriseIdentityViewSchema.parse(candidate));
        if (candidate.status === "waiting") timer = setTimeout(() => void poll(), 1500);
      } catch {
        if (active && actionGeneration.current === pollGeneration) {
          errors.fail(pollTicket);
          logger.warn("Enterprise identity polling failed");
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [owner, allowLogin, view?.status, view?.pending?.id, errors, projectView]);

  const cancelCurrentAttempt = (close = false) => {
    cancelPendingStart();
    actionGeneration.current++;
    errors.begin("clear");
    setShowUcasApiKeyPrompt(false);
    closeSurface();
    setBusy(false);
    if (close) setOpen(false);
    // 跳过只是关闭本窗口入口；无 attempt ID 的取消会中止 Host 正在恢复的设备会话。
    const attemptId = operations.activeAttemptId;
    operations.activeAttemptId = null;
    if (owner && allowLogin && attemptId) void owner.cancelLogin(attemptId).catch(warnCancellation);
  };
  const login = useCallback(async () => {
    if (!owner || !allowLogin || busy) return;
    const generation = ++actionGeneration.current;
    const ticket = errors.begin("admission");
    setShowUcasApiKeyPrompt(false);
    operations.surfaceController?.abort();
    // beginLogin 尚未返回时外部轮询可能已经认证成功；此时不能保留只属于原生扫码的
    // controller，否则认证 effect 会误触发取消并让迟到的 beginLogin 继续取消已完成的登录。
    operations.surfaceController = null;
    let controller: AbortController | null = null;
    setBusy(true);
    let startedAttemptId: string | null = null;
    try {
      await operations.startCancellation;
      if (generation !== actionGeneration.current) return;
      errors.admit(ticket);
      const starting = owner.beginLogin();
      operations.pendingStart = starting;
      const attempt = enterpriseIdentityAttemptSchema.parse(await starting);
      startedAttemptId = attempt.id;
      if (generation !== actionGeneration.current) {
        // beginLogin 可能在跳过后才返回；只取消刚取得的这次尝试。
        void owner.cancelLogin(attempt.id).catch(warnCancellation);
        return;
      }
      if (operations.pendingStart === starting) operations.pendingStart = null;
      const projection = useEnterpriseIdentityStore.getState();
      // 快速认证仍由原投影决定；提示票据不拥有认证。已知同 ID 失败也不能再打开扫码页。
      if (projection.owner === owner && projection.view?.status === "authenticated") return;
      if (errors.bind(ticket, attempt.id)) return;
      operations.activeAttemptId = attempt.id;
      if (attempt.callbackUrl) {
        if (!platform.openEnterpriseLogin)
          throw new Error("Desktop enterprise login is unavailable");
        controller = new AbortController();
        operations.surfaceController = controller;
        const surface = await surfaceGate.wait(controller.signal);
        if (generation !== actionGeneration.current) return;
        operations.nativeAttemptId = attempt.id;
        const callback = await platform.openEnterpriseLogin(
          enterpriseLoginRequestSchema.parse({ ...attempt, surface }),
        );
        if (generation !== actionGeneration.current) return;
        operations.nativeAttemptId = null;
        if (callback === null) await owner.cancelLogin(attempt.id);
        else {
          // 回调已离开原生扫码视图；先结束 surface 等待，再让 Host 发布认证状态。
          // 否则认证事件会触发下方 effect 误判为扫码取消，使成功后的引导失效。
          operations.surfaceController = null;
          const completion = enterpriseIdentityCompletionSchema.parse(
            await owner.completeLogin(attempt.id, callback),
          );
          if (generation === actionGeneration.current) {
            projectView(completion.view);
            if (
              completion.view.status === "authenticated" &&
              completion.committedAttemptId === attempt.id
            ) {
              try {
                // 自有 UWork 只配置会话出口；缺 Key 引导仅保留给旧 UCAS 协议。
                const provisioning = ucasGatewayService
                  ? await ucasGatewayService.sync("login")
                  : null;
                const latest = useEnterpriseIdentityStore.getState();
                // 只接受本窗口这次扫码完成后的身份版本；恢复、退出、其它窗口更新及迟到读取无效。
                if (
                  generation === actionGeneration.current &&
                  latest.owner === owner &&
                  latest.view?.status === "authenticated" &&
                  latest.view.revision === completion.view.revision &&
                  provisioning?.providerHasApiKey !== true
                ) {
                  const providerView = await providerSettingsService.refresh("ucas-login-prompt");
                  if (shouldRequestUcasApiKey(providerView, provisioning?.view.authMode))
                    setShowUcasApiKeyPrompt(true);
                }
              } catch {
                // 同步失败不撤销已完成的登录，也不把企业会话降级为手工密钥流程。
                logger.warn("UCAS provisioning after enterprise login failed");
              }
            }
          }
        }
        if (operations.activeAttemptId === attempt.id) operations.activeAttemptId = null;
      } else {
        // waiting 事件的快速轮询可先于 beginLogin 返回并完成认证；打开授权页前
        // 复核 Host 与本窗口投影，避免已完成的身份再弹出过期浏览器登录页。
        const latest = enterpriseIdentityViewSchema.parse(await owner.getView());
        if (generation !== actionGeneration.current) return;
        const projection = useEnterpriseIdentityStore.getState();
        if (latest.status === "authenticated") projectView(latest);
        if (
          latest.status === "authenticated" ||
          (projection.owner === owner && projection.view?.status === "authenticated")
        ) {
          if (operations.activeAttemptId === attempt.id) operations.activeAttemptId = null;
          return;
        }
        platform.openExternal(attempt.authorizationUrl);
      }
    } catch {
      if (generation === actionGeneration.current) {
        errors.fail(ticket);
        if (startedAttemptId) {
          // 就绪握手或 native 打开也可能失败；所有已开始的尝试都要取消，不能只清理已经显示的 view。
          platform.cancelEnterpriseLogin?.(startedAttemptId);
          operations.nativeAttemptId = null;
          void owner.cancelLogin(startedAttemptId).catch(warnCancellation);
          if (operations.activeAttemptId === startedAttemptId) operations.activeAttemptId = null;
        }
        logger.warn("Enterprise login failed");
      }
    } finally {
      if (controller && operations.surfaceController === controller)
        operations.surfaceController = null;
      if (generation === actionGeneration.current) setBusy(false);
    }
  }, [
    owner,
    allowLogin,
    platform,
    busy,
    surfaceGate,
    providerSettingsService,
    ucasGatewayService,
    operations,
    projectView,
  ]);
  const logout = useCallback(async () => {
    if (!owner || !allowLogin) return;
    actionGeneration.current++;
    const ticket = errors.begin("logout");
    setShowUcasApiKeyPrompt(false);
    try {
      await owner.logout();
    } catch {
      if (errors.isCurrent(ticket)) setOpen(true);
      errors.fail(ticket);
      logger.warn("Enterprise logout failed");
    }
  }, [owner, allowLogin, errors]);
  const organizations = view?.organizations ?? [];
  const selectedOrgId = view?.selectedOrgId ?? null;
  const selectOrganization = useCallback(
    async (orgId: string) => {
      if (!owner) return;
      const ticket = errors.begin("selection");
      try {
        // 偏好失败保留旧公司，并向用户显示错误；不能让界面与实际扫码组织分裂。
        const candidate = enterpriseIdentityViewSchema.parse(await owner.selectOrganization(orgId));
        projectView(candidate);
        errors.succeed(ticket);
      } catch {
        errors.fail(ticket);
        logger.warn("Enterprise identity organization selection failed");
      }
    },
    [owner, errors, projectView],
  );

  return (
    <IdentityContext.Provider
      value={{
        view,
        presentation,
        allowLogin,
        openLogin: () => {
          errors.begin("clear");
          setOpen(true);
        },
        logout,
        organizations,
        selectedOrgId,
        organizationLabel: (orgId) => {
          const match = organizations.find((organization) => organization.id === orgId);
          return match ? (match.label ?? match.id) : null;
        },
        selectOrganization,
      }}
    >
      {children}
      {/* 重新打开只覆盖工作区，不卸载 Root，以免丢失未提交草稿和标签状态。 */}
      {open && allowLogin ? (
        <EnterpriseLoginPage
          configured={owner ? (view?.configured ?? null) : false}
          waiting={busy || view?.status === "waiting"}
          organizations={organizations}
          selectedOrgId={selectedOrgId}
          error={errors.visible}
          expired={view?.error === "expired"}
          onLogin={() => void login()}
          onSelectOrg={(orgId) => void selectOrganization(orgId)}
          onBackToOrganizations={() => cancelCurrentAttempt()}
          onSkip={() => cancelCurrentAttempt(true)}
          onSurface={onSurface}
        />
      ) : null}
      {showUcasApiKeyPrompt && !open && allowLogin && view?.status === "authenticated" ? (
        <UcasApiKeyDialog
          providerSettingsService={providerSettingsService}
          onClose={() => setShowUcasApiKeyPrompt(false)}
        />
      ) : null}
    </IdentityContext.Provider>
  );
}

export function useEnterpriseIdentity(): IdentityContextValue | null {
  return useContext(IdentityContext);
}
