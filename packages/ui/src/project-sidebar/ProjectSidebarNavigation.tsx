import { Blocks, CalendarClock } from "lucide-react";
import { TID_AUTOMATIONS_OPEN } from "@zcode/shared/test-ids";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { Button } from "@/components/ui/button.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { EnterpriseNavigation } from "@/enterprise-console/EnterpriseNavigation.js";
import { useEnterpriseConsole } from "@/hooks/useEnterpriseConsole.js";

/** 顶部导航只展示 Shell 的选中状态，路由仍由 Shell 唯一持有。 */
export function ProjectSidebarNavigation({
  props,
  onCreate,
}: {
  props: Pick<
    ProjectSidebarProps,
    | "isWebRemoteControl"
    | "onOpenAutomations"
    | "automationsActive"
    | "onOpenPluginStore"
    | "pluginStoreActive"
    | "onEnterpriseNavigate"
    | "webRemoteControlWorkspaceSwitcher"
  >;
  onCreate(): void;
}) {
  const { intl } = useZCodeIntl();
  const enterpriseConsole = useEnterpriseConsole();
  const deviceNavigation = props.webRemoteControlWorkspaceSwitcher?.deviceNavigation;
  return (
    <div
      data-testid="sidebar-primary-navigation"
      className={`flex flex-col gap-1 px-2 py-3 ${props.isWebRemoteControl && !deviceNavigation ? "max-md:pt-11" : ""}`}
    >
      {/* 企业控制台接管导航时，企业菜单替代新建任务与内置入口的分发。 */}
      {props.onEnterpriseNavigate ? (
        <EnterpriseNavigation
          activeMenuId={props.automationsActive ? "agents" : props.pluginStoreActive ? "assets" : "chat"}
          onNavigate={(menu) => {
            props.onEnterpriseNavigate?.(menu);
            if (menu.builtin && menu.id === "chat") onCreate();
          }}
        />
      ) : null}
      {!enterpriseConsole.managed ? <NewTaskButtonGroup onCreateTask={onCreate} /> : null}
      {/* 修复原因：手机附件仅投影现有任务，不能恢复 UWork 已禁止的远控 Automations 导航。 */}
      {!enterpriseConsole.managed && !props.isWebRemoteControl && props.onOpenAutomations ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.automationsActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.automationsActive ?? false}
          data-testid={TID_AUTOMATIONS_OPEN}
          // 点击事件不能进入业务导航的可选 automationId 参数。
          onClick={() => props.onOpenAutomations?.()}
        >
          <CalendarClock className="size-4" />
          {intl.formatMessage({ id: "workspace.openScheduledSettings" })}
        </Button>
      ) : null}
      {!enterpriseConsole.managed ? (
        <Button
          variant="ghost"
          size="lg"
          className={`w-full justify-start gap-2 ${props.pluginStoreActive ? "bg-selected text-foreground" : ""}`}
          aria-pressed={props.pluginStoreActive ?? false}
          data-testid="plugin-store-sidebar-open"
          onClick={() => props.onOpenPluginStore?.()}
        >
          <Blocks className="size-4" />
          {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
        </Button>
      ) : null}
    </div>
  );
}
