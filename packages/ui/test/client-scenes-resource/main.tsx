import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { Emitter } from "@zcode/rpc";
import type {
  IClientScenesService,
  IEnterpriseIdentityService,
  IProviderSettingsService,
} from "@zcode/services";
import type {
  EnterpriseIdentityView,
  IPlatformService,
  UWorkClientPresentation,
} from "@zcode/shared";
import { EnterpriseIdentityProvider } from "@/hooks/useEnterpriseIdentity.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useClientScenesResource } from "@/hooks/useClientScenesResource.js";
import { useClientExperienceScope } from "@/hooks/useClientExperienceScope.js";
import { projectClientScenes } from "../../../services/src/client-scenes/clientSceneProjection.js";
import { mapClientScenesToAutomationTemplates } from "@/settings/automationTemplateCatalog.js";
import { isValidCronExpr } from "../../../services/src/session/automationCronValidation.js";

// A real React/SWR fixture. Only the identity/service boundary is synthetic; browser controls use DOM input.
const cache = new Map();
let ownerName: "A" | "B" = "A";
let version = 1;
let calls = 0;
let unavailable = false;
let holdNext = false;
let release: (() => void) | undefined;
let reject: (() => void) | undefined;
const changed = new Emitter<void>();
const published = () => ({
  draftSuggestions: [
    {
      id: `${ownerName}-${version}`,
      title: { en: `${ownerName}-draft-${version}` },
      prompt: { en: "Owned" },
    },
  ],
  scheduledTemplates: [
    {
      id: `${ownerName}-${version}`,
      title: { en: `${ownerName}-scheduled-${version}` },
      prompt: { en: "Owned" },
      cronExpr: "0 9 * * 1-5",
    },
  ],
  offPeakTemplates: [
    {
      id: `${ownerName}-${version}`,
      title: { en: `${ownerName}-offpeak-${version}` },
      prompt: { en: "Owned" },
    },
  ],
});
const projection = (): UWorkClientPresentation => ({
  status: "ready",
  version: 1,
  welcome: "Owned",
  riskNotice: "Verify",
  riskPrefix: "AI",
  scenes: unavailable ? { status: "unavailable" } : { status: "ready", version, data: published() },
  help: { status: "unsupported" },
  desktop: { status: "unsupported" },
  pluginStore: { status: "unsupported" },
});
function identity(name: string): IEnterpriseIdentityService {
  let view: EnterpriseIdentityView = {
    revision: 1,
    configured: true,
    organizations: [],
    selectedOrgId: null,
    status: "authenticated",
    profile: { id: name, tenantId: name, provider: "wecom", displayName: name },
    pending: null,
    error: null,
  };
  const emitter = new Emitter<EnterpriseIdentityView>();
  return {
    getView: async () => view,
    restoreSession: async () => view,
    readClientPresentation: async () => projection(),
    onDidChange: emitter.event,
    selectOrganization: async () => view,
    beginLogin: async () => {
      throw Error("No login in fixture");
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
      emitter.fire(view);
    },
  };
}
const owners = { A: identity("A"), B: identity("B") };
const scenes: IClientScenesService = {
  async list() {
    calls++;
    changed.fire();
    const captured = projectClientScenes(published());
    const fails = unavailable;
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((yes, no) => {
        release = yes;
        reject = () => no(Error("old-scope-failed"));
      });
    }
    if (fails) throw Error("current-scope-unavailable");
    return { code: 0, msg: "owned", data: captured };
  },
};
function Consumer({ name }: { name: string }) {
  const resource = useClientScenesResource(scenes);
  const catalog = mapClientScenesToAutomationTemplates(resource.scenes, isValidCronExpr);
  return (
    <section data-testid={`consumer-${name}`}>
      <output data-testid={`scheduled-${name}`}>
        {catalog.scheduled.map((item) => item.title.en).join(",") || "EMPTY"}
      </output>
      <output data-testid={`offpeak-${name}`}>
        {catalog.offPeak.map((item) => item.title.en).join(",") || "EMPTY"}
      </output>
      <output data-testid={`error-${name}`}>{resource.error?.message ?? "NONE"}</output>
      <button onClick={() => void resource.revalidate().catch(() => {})}>Refresh {name}</button>
    </section>
  );
}
function Fixture({ switchOwner }: { switchOwner(): void }) {
  const [first, setFirst] = useState(true);
  const [second, setSecond] = useState(true);
  const [, update] = useState(0);
  const [cacheData, setCacheData] = useState("");
  const { cache } = useSWRConfig();
  const scope = useClientExperienceScope("scenes");
  // Counter updates come from the synthetic service boundary, not browser store/React injection.
  useEffect(() => {
    const subscription = changed.event(() => update((value) => value + 1));
    return () => subscription.dispose();
  }, []);
  return (
    <main>
      <h1>Scene cache lifecycle fixture</h1>
      <output data-testid="calls">{calls}</output>
      <output data-testid="scope">{scope}</output>
      <button onClick={() => setFirst((value) => !value)}>Toggle A</button>
      <button onClick={() => setSecond((value) => !value)}>Toggle B</button>
      <button
        onClick={() => {
          setFirst(true);
          setSecond(false);
        }}
      >
        Only A
      </button>
      <button
        onClick={() => {
          setFirst((value) => !value);
          setSecond((value) => !value);
        }}
      >
        Swap readers
      </button>
      <button
        onClick={() => {
          holdNext = true;
        }}
      >
        Hold next
      </button>
      <button onClick={() => release?.()}>Release old</button>
      <button onClick={() => reject?.()}>Reject old</button>
      <button
        onClick={() => {
          version++;
          window.dispatchEvent(new Event("focus"));
        }}
      >
        Publish version
      </button>
      <button onClick={switchOwner}>Switch owner</button>
      <button
        onClick={() => {
          unavailable = true;
          switchOwner();
        }}
      >
        Switch unavailable owner
      </button>
      <button
        onClick={() => {
          unavailable = true;
          void owners[ownerName].logout();
        }}
      >
        Logout current
      </button>
      <button
        onClick={() =>
          setCacheData(
            JSON.stringify(
              [...cache.keys()].flatMap((key) => {
                const value = cache.get(key)?.data;
                return value ? [value] : [];
              }),
            ),
          )
        }
      >
        Inspect cache
      </button>
      <pre data-testid="cache-data">{cacheData}</pre>
      {first ? <Consumer name="A" /> : null}
      {second ? <Consumer name="B" /> : null}
    </main>
  );
}
function App() {
  const [owner, setOwner] = useState<"A" | "B">("A");
  return (
    <SWRConfig value={{ provider: () => cache }}>
      <ZCodeIntlProvider>
        <PlatformProvider platform={{} as IPlatformService}>
          <EnterpriseIdentityProvider
            service={owners[owner]}
            providerSettingsService={{} as IProviderSettingsService}
            showOnStartup={false}
            allowLogin={false}
          >
            <Fixture
              switchOwner={() => {
                ownerName = "B";
                setOwner("B");
              }}
            />
          </EnterpriseIdentityProvider>
        </PlatformProvider>
      </ZCodeIntlProvider>
    </SWRConfig>
  );
}
window.addEventListener("error", () => {
  document.documentElement.dataset.runtimeErrors = String(
    Number(document.documentElement.dataset.runtimeErrors ?? 0) + 1,
  );
});
window.addEventListener("unhandledrejection", () => {
  document.documentElement.dataset.runtimeErrors = String(
    Number(document.documentElement.dataset.runtimeErrors ?? 0) + 1,
  );
});
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(window.location.search).get("case") === "strict" ? (
    <StrictMode>
      <App />
    </StrictMode>
  ) : (
    <App />
  ),
);
