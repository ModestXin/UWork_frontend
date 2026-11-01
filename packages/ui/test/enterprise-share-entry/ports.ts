import type { IEnterpriseIdentityService, IProviderSettingsService } from "@zcode/services";
import type { EnterpriseIdentityView, IPlatformService } from "@zcode/shared";

function unexpected(): never {
  throw new Error("Unexpected platform or identity operation in the finite share-entry fixture");
}

// The real provider requires a platform port. This fixture exercises no platform
// operation; an accidental call fails instead of touching OS/browser services.
export const platform: IPlatformService = {
  selectDirectory: unexpected,
  selectFile: unexpected,
  onRemoteConnectionLog: unexpected,
  onRemoteSessionClosed: unexpected,
  activateOrSetWorkspace: unexpected,
  connectRemote: unexpected,
  disposeRemoteSession: unexpected,
  isDockerAvailable: unexpected,
  listWSLDistros: unexpected,
  listDockerContainers: unexpected,
  listSSHConfigAliases: unexpected,
  openExternal: unexpected,
  openFeedback: unexpected,
  openCommunity: unexpected,
  canOpenCommunity: unexpected,
  openInFileManager: unexpected,
  registerOAuthState: unexpected,
  onOAuthCallback: unexpected,
  onPaymentCallback: unexpected,
  notifyRendererReady: unexpected,
  showTaskNotification: unexpected,
  reportTelemetryEvent: unexpected,
  reportArmsCustomEvent: unexpected,
  syncWindowTabs: unexpected,
  syncWindowUnreadCount: unexpected,
  syncActiveTaskSession: unexpected,
  onFocusTab: unexpected,
  onNewTab: unexpected,
  onNewTask: unexpected,
  onOpenWorkspace: unexpected,
  onWindowFullscreenChanged: unexpected,
  onTaskNotificationClick: unexpected,
  exportLogs: unexpected,
  onUpdateReady: unexpected,
  onUpdateCheckResult: unexpected,
  downloadUpdate: unexpected,
  cancelUpdateDownload: unexpected,
  skipUpdateVersion: unexpected,
  onPostUpdateReleaseNotes: unexpected,
  acknowledgePostUpdateReleaseNotes: unexpected,
  quitAndInstallUpdate: unexpected,
  getInstalledEditors: unexpected,
  openInEditor: unexpected,
  executeDesktopCommand: unexpected,
  setApplicationLocale: unexpected,
  setTitleBarTheme: unexpected,
  getDeviceId: unexpected,
};

export const providerSettings: Pick<
  IProviderSettingsService,
  "refresh" | "setUcasApiKeyIfMissing"
> = { refresh: unexpected, setUcasApiKeyIfMissing: unexpected };

export function createIdentity(name: "A" | "B", initial: "authenticated" | "signed-out" | null) {
  const listeners = new Set<(view: EnterpriseIdentityView) => void>();
  let revision = 0;
  const view = (status: "authenticated" | "signed-out"): EnterpriseIdentityView => ({
    revision: ++revision,
    configured: true,
    error: null,
    organizations: [{ id: `owned-organization-${name}`, label: `Owned ${name}` }],
    selectedOrgId: `owned-organization-${name}`,
    ...(status === "authenticated"
      ? {
          status,
          profile: {
            id: `owned-member-${name}`,
            tenantId: `owned-organization-${name}`,
            provider: "wecom" as const,
            displayName: `Owned ${name}`,
          },
          pending: null,
        }
      : { status, profile: null, pending: null }),
  });
  let current = initial === null ? null : view(initial);
  let resolveInitial!: (value: EnterpriseIdentityView) => void;
  const pending = new Promise<EnterpriseIdentityView>((resolve) => {
    resolveInitial = resolve;
  });
  const read = () => (current === null ? pending : Promise.resolve(current));
  const publish = (status: "authenticated" | "signed-out") => {
    current = view(status);
    resolveInitial(current);
    for (const listener of listeners) listener(current);
  };
  const service: IEnterpriseIdentityService = {
    getView: read,
    restoreSession: read,
    readClientPresentation: async () => ({ status: "unavailable" }),
    selectOrganization: unexpected,
    beginLogin: unexpected,
    pollLogin: unexpected,
    completeLogin: unexpected,
    cancelLogin: unexpected,
    logout: async () => publish("signed-out"),
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return { name, service, authenticate: () => publish("authenticated") };
}
