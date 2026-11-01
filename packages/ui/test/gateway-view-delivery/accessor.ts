import type { IServiceAccessor, IUcasGatewayService } from "@zcode/services";

let unexpectedGetterAccesses = 0;
const unavailable = (name: string): never => {
  unexpectedGetterAccesses++;
  document.documentElement.dataset.ownedGetterErrors = String(unexpectedGetterAccesses);
  throw Error("Unexpected fixture service: " + name);
};
export function accessor(gateway: IUcasGatewayService): IServiceAccessor {
  const services: IServiceAccessor = {
    ucasGatewayService: gateway,
    get fileService() {
      return unavailable("fileService");
    },
    get gitService() {
      return unavailable("gitService");
    },
    get gitCheckpointService() {
      return unavailable("gitCheckpointService");
    },
    get systemService() {
      return unavailable("systemService");
    },
    get terminalService() {
      return unavailable("terminalService");
    },
    get settingService() {
      return unavailable("settingService");
    },
    get credentialService() {
      return unavailable("credentialService");
    },
    get broadcastService() {
      return unavailable("broadcastService");
    },
    get zcodeTaskService() {
      return unavailable("zcodeTaskService");
    },
    get zcodeAgentService() {
      return unavailable("zcodeAgentService");
    },
    get zcodeSessionService() {
      return unavailable("zcodeSessionService");
    },
    get conversationShareService() {
      return unavailable("conversationShareService");
    },
    get fileWatcherService() {
      return unavailable("fileWatcherService");
    },
    get oauthService() {
      return unavailable("oauthService");
    },
    get providerSettingsService() {
      return unavailable("providerSettingsService");
    },
    get modelSelectionService() {
      return unavailable("modelSelectionService");
    },
    get usageStatsService() {
      return unavailable("usageStatsService");
    },
    get codingPlanSubscriptionService() {
      return unavailable("codingPlanSubscriptionService");
    },
    get clientConfigService() {
      return unavailable("clientConfigService");
    },
    get clientScenesService() {
      return unavailable("clientScenesService");
    },
    get offPeakTaskService() {
      return unavailable("offPeakTaskService");
    },
    get skillsService() {
      return unavailable("skillsService");
    },
    get skillSyncService() {
      return unavailable("skillSyncService");
    },
    get mcpSyncService() {
      return unavailable("mcpSyncService");
    },
    get pluginSyncService() {
      return unavailable("pluginSyncService");
    },
    get pluginsService() {
      return unavailable("pluginsService");
    },
    get pluginManagementService() {
      return unavailable("pluginManagementService");
    },
    get subagentsService() {
      return unavailable("subagentsService");
    },
    get commandsService() {
      return unavailable("commandsService");
    },
    get hooksService() {
      return unavailable("hooksService");
    },
    get memoryService() {
      return unavailable("memoryService");
    },
    get settingsSyncService() {
      return unavailable("settingsSyncService");
    },
    get feedbackService() {
      return unavailable("feedbackService");
    },
    get promptAttachmentTransferService() {
      return unavailable("promptAttachmentTransferService");
    },
  };
  // React development diagnostics may enumerate context props. A real accessor read still throws.
  for (const name of Object.keys(services)) {
    if (name !== "ucasGatewayService") Object.defineProperty(services, name, { enumerable: false });
  }
  return services;
}
