// Production dispatcher/Sidebar with controlled RPC and existing-owner callbacks.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import type {
  IEnterpriseConsoleService,
  IEnterpriseIdentityService,
  IProviderSettingsService,
  IServiceAccessor,
  IBroadcastService,
} from "@zcode/services";
import type { EnterpriseIdentityView, EnterpriseMenu, IPlatformService } from "@zcode/shared";
import { EnterpriseIdentityProvider } from "@/hooks/useEnterpriseIdentity.js";
import { EnterpriseConsoleProvider } from "@/hooks/useEnterpriseConsole.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkspaceSidebar } from "@/WorkspaceSidebar.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { dispatchAuthorizedEnterpriseMenu } from "@/lib/enterpriseMenuNavigation.js";
import "@/styles.css";

const errors = () => {
  document.documentElement.dataset.runtimeErrors = String(
    Number(document.documentElement.dataset.runtimeErrors ?? 0) + 1,
  );
};
window.addEventListener("error", errors);
window.addEventListener("unhandledrejection", errors);
const changed = new Emitter<EnterpriseIdentityView>();
const profile = {
  id: "controlled",
  tenantId: "tenant",
  provider: "wecom" as const,
  displayName: "Controlled",
};
let view: EnterpriseIdentityView = {
  revision: 1,
  configured: true,
  organizations: [],
  selectedOrgId: null,
  status: "authenticated",
  profile,
  pending: null,
  error: null,
};
const identity: IEnterpriseIdentityService = {
  getView: async () => view,
  restoreSession: async () => view,
  readClientPresentation: async () => ({ status: "unmanaged" }),
  selectOrganization: async () => view,
  beginLogin: async () => {
    throw new Error("controlled fixture");
  },
  pollLogin: async () => view,
  completeLogin: async () => ({ view, committedAttemptId: null }),
  cancelLogin: async () => {},
  logout: async () => {
    view = { ...view, revision: view.revision + 1, status: "signed-out", profile: null };
    changed.fire(view);
  },
  onDidChange: changed.event,
};
let menus: EnterpriseMenu[] = [
  {
    id: "portal",
    name: "企业门户",
    nameEn: "Portal",
    enabled: true,
    builtin: false,
    url: "https://portal.example.test/",
    icon: "globe",
  },
  {
    id: "agents",
    name: "自动化",
    nameEn: "Automations",
    enabled: true,
    builtin: true,
    icon: "bot",
  },
  {
    id: "assets",
    name: "插件商店",
    nameEn: "Plugin Store",
    enabled: true,
    builtin: true,
    icon: "library",
  },
  { id: "chat", name: "对话", nameEn: "Chat", enabled: true, builtin: true, icon: "message" },
];
let slowMenu = false,
  releaseMenu: (() => void) | undefined,
  denyNext: string | undefined;
let fail = false,
  unmanaged = false,
  version = 0;
const emptyService = new Proxy(
  {},
  {
    get: (_target, key) =>
      String(key).startsWith("on") ? () => ({ dispose() {} }) : async () => ({}),
  },
);
const fixtureServices = new Proxy(
  {},
  {
    get: (_target, key) =>
      ["windowControllerService", "ucasGatewayService"].includes(String(key))
        ? undefined
        : emptyService,
  },
) as IServiceAccessor;
const broadcast = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as unknown as IBroadcastService;
const forbiddenResourceCall = async (): Promise<never> => {
  document.documentElement.dataset.resourceCalls = String(
    Number(document.documentElement.dataset.resourceCalls ?? 0) + 1,
  );
  throw new Error("menu navigation must not request enterprise resource APIs");
};
const consoleService: IEnterpriseConsoleService = {
  getNavigation: async () =>
    unmanaged
      ? { status: "unmanaged" }
      : fail
        ? { status: "unavailable" }
        : { status: "ready", version, items: menus.filter((menu) => menu.enabled) },
  authorizeMenu: async (id) => {
    if (denyNext === id) {
      denyNext = undefined;
      menus = menus.map((menu) => (menu.id === id ? { ...menu, enabled: false } : menu));
      throw new Error("menu revoked");
    }
    const menu = menus.find((value) => value.id === id && value.enabled);
    if (fail || view.status !== "authenticated" || !menu)
      throw new Error("enterprise_console_unavailable");
    const captured = structuredClone(menu);
    if (slowMenu) {
      slowMenu = false;
      await new Promise<void>((resolve) => {
        releaseMenu = resolve;
      });
    }
    return captured;
  },
  listAgents: forbiddenResourceCall,
  listAssets: forbiddenResourceCall,
  listRuns: forbiddenResourceCall,
  createRun: forbiddenResourceCall,
  readRun: forbiddenResourceCall,
  cancelRun: forbiddenResourceCall,
};
const refresh = () => {
  version++;
  window.dispatchEvent(new Event("focus"));
};
const bump = (key: string) => {
  document.documentElement.dataset[key] = String(
    Number(document.documentElement.dataset[key] ?? 0) + 1,
  );
};
function Fixture() {
  const [route, setRoute] = useState("chat"),
    [showSidebar, setShowSidebar] = useState(true);
  const owners = {
    openChat: () => {
      setRoute("chat");
      bump("chatOpen");
    },
    openAutomations: () => {
      setRoute("automations");
      bump("automationsOpen");
    },
    openPluginStore: () => {
      setRoute("plugin-store");
      bump("pluginStoreOpen");
    },
    openBrowserUrl: (url: string) => {
      document.documentElement.dataset.externalUrl = url;
    },
  };
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", height: "100vh", overflow: "auto" }}
      className="min-w-0 bg-background text-foreground"
    >
      <aside style={{ width: 240, maxWidth: "100%", flexShrink: 0 }} className="border-border p-2">
        <div className="flex flex-wrap gap-2 text-ui-sm">
          <button
            onClick={() => {
              menus = menus.map((menu) =>
                menu.id === "agents" ? { ...menu, name: "团队计划", nameEn: "Team Plans" } : menu,
              );
              refresh();
            }}
          >
            自定义名称
          </button>
          <button
            onClick={() => {
              menus = menus.map((menu) =>
                menu.id === "agents" ? { ...menu, name: "智能体", nameEn: "Agents" } : menu,
              );
              refresh();
            }}
          >
            已发布旧标题
          </button>
          <button
            onClick={() => {
              denyNext = "agents";
            }}
          >
            撤销下一次自动化准入
          </button>
          <button
            onClick={() => {
              menus = menus.map((menu) =>
                menu.id === "assets" ? { ...menu, enabled: false } : menu,
              );
              refresh();
            }}
          >
            关闭商店入口
          </button>
          <button
            onClick={() => {
              slowMenu = true;
            }}
          >
            延迟菜单
          </button>
          <button onClick={() => releaseMenu?.()}>释放菜单</button>
          <button onClick={() => void identity.logout()}>退出身份</button>
          <button
            onClick={() => {
              view = { ...view, revision: view.revision + 1, status: "authenticated", profile };
              changed.fire(view);
            }}
          >
            恢复身份
          </button>
          <button
            onClick={() => {
              fail = true;
              refresh();
            }}
          >
            服务故障
          </button>
          <button
            onClick={() => {
              fail = false;
              unmanaged = false;
              menus = menus.map((menu) => ({ ...menu, enabled: true }));
              refresh();
            }}
          >
            恢复菜单
          </button>
          <button
            onClick={() => {
              menus = menus.map((menu) =>
                menu.id === "chat" ? { ...menu, enabled: false } : menu,
              );
              refresh();
            }}
          >
            关闭对话入口
          </button>
          <button
            onClick={() => {
              unmanaged = true;
              refresh();
            }}
          >
            UCAS模式
          </button>
          <button onClick={() => setShowSidebar((value) => !value)}>切换侧栏</button>
        </div>
        {showSidebar ? (
          <div style={{ height: 700 }}>
            <WorkspaceSidebar
              workspacePath="/controlled"
              onSelectTask={() => {}}
              onStartDraftInWorkspace={() => {}}
              onCreateTask={() => bump("createdLocalTask")}
              onCreateConversationTask={() => {}}
              onOpenFolderFromWorkspaceMenu={() => {}}
              theme="zai-light"
              onConnectRemote={async () => ""}
              onSelectRemoteProject={async () => {}}
              onCancelRemoteProject={async () => {}}
              onReconnectRemoteWorkspace={async () => {}}
              reconnectingRemoteWorkspaceKeys={[]}
              remoteWorkspaceErrorByWorkspaceKey={{}}
              onOpenCommandCenter={() => {}}
              automationsActive={route === "automations"}
              pluginStoreActive={route === "plugin-store"}
              onOpenAutomations={owners.openAutomations}
              onOpenPluginStore={owners.openPluginStore}
              onEnterpriseNavigate={(menu) => dispatchAuthorizedEnterpriseMenu(menu, owners)}
            />
          </div>
        ) : null}
      </aside>
      <main style={{ flex: "1 1 400px", minWidth: 0 }}>
        <p className="p-4" data-testid={`existing-${route}-owner`}>
          既有页面所有者：{route}
        </p>
      </main>
    </div>
  );
}
localStorage.setItem("zcode-locale-preference", "zh-CN");
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider>
    <TooltipProvider>
      <PlatformProvider platform={{ getPlatform: () => "web" } as unknown as IPlatformService}>
        <ServiceProvider services={fixtureServices}>
          <StoreProvider broadcastService={broadcast}>
            <TabStoreProvider>
              <EnterpriseIdentityProvider
                service={identity}
                providerSettingsService={{} as IProviderSettingsService}
                showOnStartup={false}
                allowLogin={false}
              >
                <EnterpriseConsoleProvider service={consoleService}>
                  <Fixture />
                </EnterpriseConsoleProvider>
              </EnterpriseIdentityProvider>
            </TabStoreProvider>
          </StoreProvider>
        </ServiceProvider>
      </PlatformProvider>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
