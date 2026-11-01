// Independent controlled fixture: production UI/provider, synthetic identity RPC only.
import { createRoot } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import type { IEnterpriseIdentityService, IProviderSettingsService } from "@zcode/services";
import type {
  EnterpriseIdentityView,
  IPlatformService,
  UWorkClientPresentation,
} from "@zcode/shared";
import { EnterpriseIdentityProvider } from "@/hooks/useEnterpriseIdentity.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { EnterpriseRiskNotice } from "@/v4/EnterpriseRiskNotice.js";
import "@/styles.css";

const changed = new Emitter<EnterpriseIdentityView>();
const observeError = () => {
  document.documentElement.dataset.runtimeErrors = String(
    Number(document.documentElement.dataset.runtimeErrors ?? 0) + 1,
  );
};
window.addEventListener("error", observeError);
window.addEventListener("unhandledrejection", observeError);
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
let projection: UWorkClientPresentation = {
  status: "ready",
  version: 1,
  welcome: "企业欢迎".repeat(50),
  riskNotice: "重要信息请核实。".repeat(30),
  riskPrefix: "内容由 AI 生成",
  scenes: { status: "unsupported" },
  help: { status: "unsupported" },
  desktop: { status: "unsupported" },
  pluginStore: { status: "unsupported" },
};
let slow = false;
let release: (() => void) | undefined;
const service: IEnterpriseIdentityService = {
  getView: async () => view,
  restoreSession: async () => view,
  readClientPresentation: async () => {
    const captured = structuredClone(projection);
    document.documentElement.dataset.reads = String(
      Number(document.documentElement.dataset.reads ?? 0) + 1,
    );
    if (slow) {
      slow = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return captured;
  },
  selectOrganization: async () => view,
  beginLogin: async () => {
    throw new Error("fixture has no login");
  },
  pollLogin: async () => view,
  completeLogin: async () => ({ view, committedAttemptId: null }),
  cancelLogin: async () => {},
  logout: async () => {
    view = {
      ...view,
      revision: view.revision + 1,
      status: "signed-out",
      profile: null,
      pending: null,
    };
    changed.fire(view);
  },
  onDidChange: changed.event,
};
const refresh = () => window.dispatchEvent(new Event("focus"));
function Fixture() {
  return (
    <main className="min-w-0 bg-background text-foreground">
      <div className="flex flex-wrap gap-2 p-3">
        <button
          data-testid="publish"
          onClick={() => {
            projection = {
              status: "ready",
              version: 2,
              welcome: "新发布欢迎",
              riskNotice: "新发布风险",
              riskPrefix: "内容由 AI 生成",
              scenes: { status: "unsupported" },
              help: { status: "unsupported" },
              desktop: { status: "unsupported" },
              pluginStore: { status: "unsupported" },
            };
            refresh();
          }}
        >
          发布
        </button>
        <button
          data-testid="empty"
          onClick={() => {
            if (projection.status === "ready") projection = { ...projection, welcome: "" };
            refresh();
          }}
        >
          空欢迎
        </button>
        <button
          data-testid="slow"
          onClick={() => {
            slow = true;
            refresh();
          }}
        >
          慢读取
        </button>
        <button data-testid="release" onClick={() => release?.()}>
          释放旧请求
        </button>
        <button data-testid="logout" onClick={() => void service.logout()}>
          退出
        </button>
        <button
          data-testid="signin"
          onClick={() => {
            view = {
              ...view,
              revision: view.revision + 1,
              status: "authenticated",
              profile,
              pending: null,
            };
            changed.fire(view);
          }}
        >
          恢复身份
        </button>
        <button
          data-testid="fail"
          onClick={() => {
            projection = { status: "unavailable" };
            refresh();
          }}
        >
          失败
        </button>
      </div>
      <div className="relative h-96 overflow-hidden">
        <ConversationDraftEmptyState />
      </div>
      <EnterpriseRiskNotice />
    </main>
  );
}
localStorage.setItem("zcode-locale-preference", "zh-CN");
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider>
    <PlatformProvider platform={{} as IPlatformService}>
      <EnterpriseIdentityProvider
        service={service}
        providerSettingsService={{} as IProviderSettingsService}
        showOnStartup={false}
        allowLogin={false}
      >
        <Fixture />
      </EnterpriseIdentityProvider>
    </PlatformProvider>
  </ZCodeIntlProvider>,
);
