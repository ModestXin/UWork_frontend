import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import type { IEnterpriseIdentityService, IProviderSettingsService } from "@zcode/services";
import {
  enterpriseIdentityViewSchema,
  enterpriseLoginAuthorizationSchema,
  type EnterpriseIdentityAttempt,
  type EnterpriseIdentityView,
  type IPlatformService,
} from "@zcode/shared";
import { EnterpriseIdentityProvider } from "@/hooks/useEnterpriseIdentity.js";
import { createNativeRaceProbe } from "./nativeRaceFixture.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import "@/styles.css";

// A finite synthetic service/platform port, not Native or real authentication.
const params = new URLSearchParams(location.search);
const scenario = params.get("case") ?? "reopen";
const deferNativeResult = ["poll-native-null", "poll-native-aborted"].includes(scenario);
const channel = new BroadcastChannel("owned-login-error-" + params.get("channel"));
const changed = new Emitter<void>();
const probe = createNativeRaceProbe(() => changed.fire());
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
type Gate<T> = ReturnType<typeof deferred<T>>;
let native = deferred<string | null>();
const opened: string[] = [];
let externalOpens = 0;
let currentOwner = "A";
let switchOwner: (() => void) | undefined;
let controllerAcks = 0;
let runtimeErrors = 0;
window.addEventListener("error", () => {
  runtimeErrors++;
  changed.fire();
});
window.addEventListener("unhandledrejection", () => {
  runtimeErrors++;
  changed.fire();
});

class SyntheticHost {
  readonly events = new Emitter<EnterpriseIdentityView>();
  view: EnterpriseIdentityView;
  starts = 0;
  reads = 0;
  selects = 0;
  cancelled: string[] = [];
  startGate: Gate<EnterpriseIdentityAttempt> | null = null;
  selectGate: Gate<void> | null = null;
  pollGate: Gate<EnterpriseIdentityView> | null = null;
  completeGate: Gate<{ view: EnterpriseIdentityView; committedAttemptId: null }> | null = null;
  cancelGate: Gate<void> | null = null;
  logoutGate: Gate<void> | null = null;
  attempt: EnterpriseIdentityAttempt | null = null;
  waitingSnapshot: EnterpriseIdentityView | null = null;
  selectionAllowed = scenario !== "select-fail";
  constructor(readonly name: string) {
    this.view = {
      revision: 0,
      configured: true,
      status: "signed-out",
      profile: null,
      pending: null,
      error: null,
      organizations: [
        { id: "a", label: "公司 A" },
        { id: "b", label: "公司 B" },
      ],
      selectedOrgId: "a",
    };
  }
  publish(patch: Partial<EnterpriseIdentityView>, emit = true) {
    this.view = enterpriseIdentityViewSchema.parse({
      ...this.view,
      ...patch,
      revision: this.view.revision + 1,
    });
    if (emit) this.events.fire(structuredClone(this.view));
    changed.fire();
    return structuredClone(this.view);
  }
  failed(emit = true) {
    return this.publish(
      { status: "signed-out", profile: null, pending: null, error: "failed" },
      emit,
    );
  }
  waiting(attempt: EnterpriseIdentityAttempt) {
    this.attempt = attempt;
    this.waitingSnapshot = this.publish({
      status: "waiting",
      profile: null,
      pending: { id: attempt.id, expiresAt: attempt.expiresAt, callbackUrl: attempt.callbackUrl },
      error: null,
    });
    return attempt;
  }
  makeAttempt() {
    const id = `${this.name}-${this.starts}`;
    const callbackUrl = "https://identity.fixture/callback";
    return enterpriseLoginAuthorizationSchema.parse({
      id,
      expiresAt: Date.now() + 60000,
      callbackUrl,
      authorizationUrl:
        "https://login.work.weixin.qq.com/wwlogin/sso/login?" +
        new URLSearchParams({
          login_type: "CorpApp",
          appid: "owned-app",
          agentid: "100",
          redirect_uri: callbackUrl,
          state: id,
        }),
    });
  }
  async select(orgId: string) {
    this.selects++;
    changed.fire();
    if (scenario.startsWith("old-select") || scenario === "owner-selection") {
      this.selectGate = deferred<void>();
      await this.selectGate.promise;
    }
    if (!this.selectionAllowed) throw Error("Owned preference write failed");
    // Real Host selection republishes its current diagnostic; it does NOT clear failed.
    return this.publish({ selectedOrgId: orgId });
  }
  begin() {
    this.starts++;
    changed.fire();
    const attempt = this.makeAttempt();
    const held =
      [
        "late-id",
        "auth-late-id",
        "old-start-success",
        "old-start-fail",
        "owner-barrier-hold",
        "owner-barrier-reject",
        "owner-direct",
        "same-owner-barrier-reject",
      ].includes(scenario) &&
      this.name === "A" &&
      this.starts === 1;
    if (held) {
      this.startGate = deferred<EnterpriseIdentityAttempt>();
      this.attempt = attempt;
      if (scenario === "late-id" || scenario === "auth-late-id") this.waiting(attempt);
      return this.startGate.promise;
    }
    if (
      ["reopen", "select", "no-id-repeat", "old-select-success"].includes(scenario) ||
      (scenario === "old-poll-current" && this.starts > 1) ||
      this.name === "B"
    ) {
      this.failed();
      return Promise.reject(new Error("Owned no-ID start failure"));
    }
    return Promise.resolve(this.waiting(attempt));
  }
  service: IEnterpriseIdentityService = {
    getView: async () => {
      this.reads++;
      return structuredClone(this.view);
    },
    restoreSession: async () => structuredClone(this.view),
    readClientPresentation: async () => ({ status: "unmanaged" }),
    onDidChange: (listener) => this.events.event(listener),
    selectOrganization: (id) => this.select(id),
    beginLogin: () => this.begin(),
    pollLogin: async () => {
      this.pollGate ??= deferred<EnterpriseIdentityView>();
      probe.enterPoll();
      return this.pollGate.promise;
    },
    completeLogin: async () => {
      this.completeGate = deferred<{ view: EnterpriseIdentityView; committedAttemptId: null }>();
      changed.fire();
      return this.completeGate.promise;
    },
    cancelLogin: async (id) => {
      if (!id) throw Error("Cancellation requires an actual attempt ID");
      this.cancelled.push(id);
      changed.fire();
      if (id !== this.attempt?.id) return;
      if (
        ["owner-barrier-reject", "same-owner-barrier-reject"].includes(scenario) &&
        this.name === "A"
      ) {
        this.cancelGate ??= deferred<void>();
        await this.cancelGate.promise;
      }
      this.attempt = null;
      this.publish({ status: "signed-out", profile: null, pending: null, error: null });
    },
    logout: async () => {
      if (scenario === "owner-logout" && this.name === "A") {
        this.logoutGate = deferred<void>();
        changed.fire();
        await this.logoutGate.promise;
      }
      this.publish({ status: "signed-out", profile: null, pending: null, error: null });
    },
  };
}
const hosts = { A: new SyntheticHost("A"), B: new SyntheticHost("B") };
const host = () => hosts[currentOwner as keyof typeof hosts];
const commands = [
  "release-start",
  "fail-view",
  "republish-failed",
  "old-snapshot",
  "release-poll",
  "reject-poll",
  "callback",
  "release-complete",
  "allow-selection",
  "release-selection",
  "reject-selection",
  "owner-b",
  "authenticate",
  "resolve-native-null",
  "reject-native-aborted",
  "reject-cancel",
  "reject-logout",
] as const;
type Command = (typeof commands)[number];
function control(command: Command) {
  const h = host();
  switch (command) {
    case "release-start": {
      const a = hosts.A;
      if (scenario === "old-start-fail") {
        a.failed();
        a.startGate?.reject(Error("Old start failed"));
      } else if (a.attempt) {
        if (scenario !== "late-id" && scenario !== "auth-late-id") a.waiting(a.attempt);
        a.startGate?.resolve(a.attempt);
      }
      break;
    }
    case "fail-view":
      h.failed();
      break;
    case "republish-failed":
      h.publish({});
      break;
    case "old-snapshot":
      if (h.waitingSnapshot) h.events.fire(structuredClone(h.waitingSnapshot));
      break;
    case "release-poll":
      h.pollGate?.resolve(h.failed(false));
      break;
    case "reject-poll":
      h.pollGate?.reject(Error("Old poll failed"));
      break;
    case "callback":
      native.resolve("https://identity.fixture/callback?state=" + h.attempt?.id + "&code=owned");
      break;
    case "release-complete":
      h.completeGate?.resolve({ view: h.failed(false), committedAttemptId: null });
      break;
    case "allow-selection":
      h.selectionAllowed = true;
      break;
    case "release-selection":
      hosts.A.selectGate?.resolve();
      break;
    case "reject-selection":
      hosts.A.selectGate?.reject(Error("Old selection failed"));
      break;
    case "owner-b":
      currentOwner = "B";
      switchOwner?.();
      break;
    case "authenticate": {
      const view = h.publish(
        {
          status: "authenticated",
          profile: { id: "owned", tenantId: "owned", provider: "wecom", displayName: "合成用户" },
          pending: null,
          error: null,
        },
        !deferNativeResult,
      );
      // C3 只交付原 poll promise，不发身份事件绕过待测 effect。
      if (deferNativeResult) h.pollGate?.resolve(view);
      break;
    }
    case "resolve-native-null":
      native.resolve(null);
      break;
    case "reject-native-aborted":
      native.reject(Error("ERR_ABORTED"));
      break;
    case "reject-cancel":
      hosts.A.cancelGate?.reject(Error("Old owner cancellation failed"));
      break;
    case "reject-logout":
      hosts.A.logoutGate?.reject(Error("Old owner logout failed"));
      break;
  }
  controllerAcks++;
  changed.fire();
}
if (params.has("controller")) {
  createRoot(document.getElementById("root")!).render(
    <main>
      <h1>Finite owned fixture controller</h1>
      {commands.map((command) => (
        <button key={command} onClick={() => channel.postMessage(command)}>
          {command}
        </button>
      ))}
    </main>,
  );
} else {
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (commands.includes(event.data as Command)) control(event.data as Command);
  };
  const platform = {
    isDesktop: true,
    openExternal: () => {
      externalOpens++;
      changed.fire();
    },
    openEnterpriseLogin: (request: { id: string }) => {
      opened.push(request.id);
      native = deferred<string | null>();
      changed.fire();
      return deferNativeResult ? probe.open(native.promise) : native.promise;
    },
    cancelEnterpriseLogin: (id: string) => {
      probe.close(id);
      if (!deferNativeResult) native.resolve(null);
    },
    updateEnterpriseLogin: () => {},
  } as unknown as IPlatformService;
  const providerSettings = {
    refresh: async () => ({ revision: 1, providers: [] }),
    setUcasApiKeyIfMissing: async () => ({}),
  } as unknown as IProviderSettingsService;
  function Fixture() {
    const [, render] = useState(0);
    const [owner, setOwner] = useState<"A" | "B">("A");
    useEffect(() => {
      const subscription = changed.event(() => render((value) => value + 1));
      switchOwner = () => setOwner("B");
      return () => {
        subscription.dispose();
        switchOwner = undefined;
      };
    }, []);
    const state = {
      owner,
      controllerAcks,
      runtimeErrors,
      externalOpens,
      opened,
      ...probe.facts,
      A: {
        view: hosts.A.view,
        reads: hosts.A.reads,
        starts: hosts.A.starts,
        selects: hosts.A.selects,
        cancelled: hosts.A.cancelled,
      },
      B: {
        view: hosts.B.view,
        reads: hosts.B.reads,
        starts: hosts.B.starts,
        cancelled: hosts.B.cancelled,
      },
      pollPending: !!host().pollGate,
      completePending: !!host().completeGate,
    };
    return (
      <PlatformProvider platform={platform}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <EnterpriseIdentityProvider
            service={hosts[owner].service}
            providerSettingsService={providerSettings}
            ucasGatewayService={deferNativeResult ? probe.gateway : undefined}
            showOnStartup
          >
            <probe.Launcher />
            <output data-testid="fixture-facts">{JSON.stringify(state)}</output>
          </EnterpriseIdentityProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    );
  }
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
