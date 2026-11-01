/* eslint-disable max-lines -- 远程 workspace 服务注册需集中维护，以保持依赖注入顺序 */
import {
  ServiceCollection,
  IFileService,
  IGenUiService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IConversationShareService,
  createUnsupportedConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IEnterpriseIdentityService,
  IModelSelectionService,
  IProviderSettingsService,
  ISourceServerWorkspaceService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  IProjectService,
  ITaskGroupService,
  IRemoteProjectService,
  IPromptAttachmentTransferService,
  type ServiceDescriptor,
  type IServiceAccessor,
} from "@zcode/services";
import {
  ConversationShareHttpClient,
  ConversationShareService,
  createSettingService,
  createCredentialService,
  createPublicCredentialService,
  createNodeApiClient,
  createHostApiNetworkTransport,
  createOAuthService,
  createOAuthProviderLogoutHandler,
  createAccountProviderCredentialStore,
  createAccountProviderCredentialService,
  createAccountProviderRequestAuthService,
  createAccountRequestAuthService,
  resolveCurrentAccountAccess,
  resolveAccountTeamPlanRuntimeMaterial,
  createSettingsSyncService,
  createUsageStatsService,
  createMediaPreviewService,
  createCodingPlanSubscriptionService,
  readEnterpriseIdentityTurnPresentation,
  createServiceLogger,
  createSubagentsService,
  createMemoryService,
  createRemoteConversationShareArtifactSource,
  OAuthCredentialRepo,
  createLegacySingleRootProjectService,
  createRemoteProjectService,
} from "@zcode/services/node";
import {
  BIGMODEL_PROVIDER_ID,
  buildRuntimeZCodeApiUrl,
  buildServerRemoteWorkspaceIdentity,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  remoteHostIdFromWorkspaceIdentity,
  type ProviderFamilyDomain,
  type ZCodeSessionRuntimePreferencesResult,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import type { RemoteTarget } from "@zcode/shared";
import {
  REMOTE_WORKSPACE_RPC_CHANNELS,
  assertRemoteWorkspaceRpcContract,
} from "./remoteWorkspaceRpcContract.js";
import { assertLegacyRemoteWorkspaceRpcContract } from "./legacyRemoteWorkspaceRpcContract.js";
import {
  createRemoteProviderProvisioningExecutorFromWorkspace,
  registerRemoteProviderProvisioningExecutor,
} from "./remoteProviderProvisioningService.js";

const runtimePreferencesLogger = createServiceLogger("remote-runtime-preferences");
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

export const REMOTE_WORKSPACE_RPC_REGISTRATIONS = [
  ["fileService", IFileService],
  ["genUiService", IGenUiService],
  ["mediaPreviewService", IMediaPreviewService],
  ["gitService", IGitService],
  ["gitCheckpointService", IGitCheckpointService],
  ["systemService", ISystemService],
  ["terminalService", ITerminalService],
  ["settingService", ISettingService],
  ["onboardingRecordService", IOnboardingRecordService],
  ["credentialService", ICredentialService],
  ["broadcastService", IBroadcastService],
  ["zcodeTaskService", IZCodeTaskService],
  ["zcodeAgentService", IZCodeAgentService],
  ["zcodeSessionService", IZCodeSessionService],
  ["conversationShareService", IConversationShareService],
  ["botsService", IBotsService],
  ["fileWatcherService", IFileWatcherService],
  ["oauthService", IOAuthService],
  ["providerSettingsService", IProviderSettingsService],
  ["modelSelectionService", IModelSelectionService],
  ["sourceServerWorkspaceService", ISourceServerWorkspaceService],
  ["usageStatsService", IUsageStatsService],
  ["codingPlanSubscriptionService", ICodingPlanSubscriptionService],
  ["clientScenesService", IClientScenesService],
  ["skillsService", ISkillsService],
  ["skillSyncService", ISkillSyncService],
  ["mcpSyncService", IMcpSyncService],
  ["pluginSyncService", IPluginSyncService],
  ["pluginsService", IPluginsService],
  ["pluginManagementService", IPluginManagementService],
  ["subagentsService", ISubagentsService],
  ["commandsService", ICommandsService],
  ["hooksService", IHooksService],
  ["memoryService", IMemoryService],
  ["outputStyleService", IOutputStyleService],
  ["settingsSyncService", ISettingsSyncService],
  ["promptAttachmentTransferService", IPromptAttachmentTransferService],
] as const satisfies readonly [keyof IServiceAccessor, ServiceDescriptor<unknown>][];

const conversationShareLog = createServiceLogger("conversation-share");

function createUnsupportedRemoteConversationShareService(): IConversationShareService {
  return createUnsupportedConversationShareService({
    message: "Conversation sharing is not available for this client or remote target",
    onRejected: (action) => {
      conversationShareLog.warn(undefined, "conversation share action rejected", {
        action,
        kind: "feature_disabled",
        reason: "server_remote_unsupported",
      });
    },
  });
}

export function resolveServerProjectService(params: {
  connectionServices: IServiceAccessor;
  serverId: string;
  virtualProjects?: boolean;
  sourceServices?: ServiceCollection;
}): IProjectService {
  if (params.virtualProjects) {
    if (!params.connectionServices.projectService)
      throw new Error("Remote virtual-project RPC registration incomplete");
    return params.connectionServices.projectService;
  }
  const hostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: params.serverId, workspacePath: "/" }),
  )!;
  return createLegacySingleRootProjectService({
    hostId,
    directories: {
      info: () => params.connectionServices.systemService.info(),
      read: (input) => params.connectionServices.fileService.readdir(input),
    },
    readSettings: () => params.connectionServices.settingService.get(),
    readKnownWorkspaces: async () => {
      const directory = await params.sourceServices
        ?.getOptional(IRemoteProjectService)
        ?.readDirectory();
      return (directory?.entries ?? [])
        .filter((entry) => entry.hostId === hostId)
        .flatMap((entry) =>
          entry.roots.length
            ? entry.roots.map((root) => ({ workspacePath: root.rootPath }))
            : entry.legacyWorkspace
              ? [
                  {
                    workspacePath: entry.legacyWorkspace.workspacePath,
                    workspacePurpose: entry.legacyWorkspace.workspacePurpose,
                  },
                ]
              : [],
        );
    },
    readTasks: ({ workspacePath, kind }) => {
      const tasks = params.connectionServices.zcodeTaskService;
      const scope = { workspacePath };
      return kind === "pinned"
        ? tasks.listPinnedTasks(scope)
        : kind === "archived"
          ? tasks.listArchivedTasks(scope)
          : tasks.listTasks(scope);
    },
    ensureConversation: async () =>
      (await params.connectionServices.fileService.ensureConversationWorkspace()).path,
  });
}

export function createServerRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  virtualProjects?: boolean;
  serverId?: string;
  targetKind: RemoteTarget["kind"];
  /** 本机 Local Host 服务；提供 Provider Provisioning Source，缺失时 Provisioning 按 unsupported 处理。 */
  sourceServices?: ServiceCollection;
}): ServiceCollection {
  assertRemoteWorkspaceRpcContract(params.connectionServices);
  // Server remote 连接的是一个已经运行的完整 ZCode server。
  // Host 只做 RPC 转接，不替 server 决定 workspace/runtime/provider 归属；
  // Provider 配置只经 Host 私有的 Provisioning executor 从本机单向下发到远端。
  const remoteProviderProvisioningExecutor =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    // 根因：客户端已有 gen-ui 代理，但 Host 漏转发使远端读取成为 Unknown channel。
    // 复用 Source 的读取与输出目录校验；桌面状态/沙箱仍由 base services 提供。
    .register(IGenUiService, params.connectionServices.genUiService)
    .register(IMediaPreviewService, params.connectionServices.mediaPreviewService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, params.connectionServices.settingService)
    // Bug 原因：远程集合曾漏注册此通道，手机重建 Root 后调用失败，回退 settings 判定而误弹引导。
    // 引导记录必须与该入口的 settings/OAuth 同源：R3 下四种 transport 都由 Source 持有，不借用本机记录。
    .register(IOnboardingRecordService, params.connectionServices.onboardingRecordService)
    // 企业身份凭据只供 Host 使用：这层 Renderer/Web 凭据 RPC 不能绕过身份服务读取或伪造会话。
    .register(
      ICredentialService,
      createPublicCredentialService(params.connectionServices.credentialService),
    )
    .register(IBroadcastService, params.connectionServices.broadcastService)
    .register(IZCodeTaskService, params.connectionServices.zcodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, params.connectionServices.zcodeSessionService)
    // R3 的分享属于目标 Environment；不能恢复旧 SSH 的本机 JWT 混装。
    .register(
      IConversationShareService,
      params.targetKind === "server"
        ? createUnsupportedRemoteConversationShareService()
        : params.connectionServices.conversationShareService,
    )
    .register(IBotsService, params.connectionServices.botsService)
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(IOAuthService, params.connectionServices.oauthService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(ISourceServerWorkspaceService, params.connectionServices.sourceServerWorkspaceService)
    .register(IUsageStatsService, params.connectionServices.usageStatsService)
    .register(
      ICodingPlanSubscriptionService,
      params.connectionServices.codingPlanSubscriptionService,
    )
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, params.connectionServices.clientScenesService)
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    // Bug 原因：RPC 合同已经要求 plugin-sync，但旧全转发集合漏注册，远端插件同步会在 Host
    // 二次暴露时变成 Unknown channel。全转发集合必须与合同逐项一致。
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ISubagentsService, params.connectionServices.subagentsService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, params.connectionServices.memoryService)
    .register(IOutputStyleService, params.connectionServices.outputStyleService)
    .register(ISettingsSyncService, params.connectionServices.settingsSyncService)
    .register(
      IPromptAttachmentTransferService,
      params.connectionServices.promptAttachmentTransferService,
    );
  // 新频道必须以握手能力为准；客户端总能生成 proxy，不能用对象存在性判断旧 Server 支持。
  if (params.virtualProjects) {
    if (
      !params.connectionServices.projectService ||
      !params.connectionServices.remoteProjectService
    )
      throw new Error("Remote virtual-project RPC registration incomplete");
    services.register(IProjectService, params.connectionServices.projectService);
    services.register(IRemoteProjectService, params.connectionServices.remoteProjectService);
  } else if (params.serverId) {
    services.register(
      IProjectService,
      resolveServerProjectService({ ...params, serverId: params.serverId }),
    );
    services.register(
      IRemoteProjectService,
      createRemoteProjectService({
        controller: false,
        database: async () => {
          throw new Error("remote-project.controller-only");
        },
      }),
    );
  }
  const controllerGroups = params.sourceServices?.getOptional(ITaskGroupService);
  const controllerBroadcast = params.sourceServices?.getOptional(IBroadcastService);
  if (controllerGroups) services.register(ITaskGroupService, controllerGroups);
  if (controllerGroups && controllerBroadcast) {
    const remoteBroadcast = params.connectionServices.broadcastService;
    services.register(IBroadcastService, {
      send: (message) =>
        (message.channel === "state:task-groups" ? controllerBroadcast : remoteBroadcast).send(
          message,
        ),
      acquireClaim: (key) => remoteBroadcast.acquireClaim(key),
      commitClaim: (lease) => remoteBroadcast.commitClaim(lease),
      releaseClaim: (lease) => remoteBroadcast.releaseClaim(lease),
      tryClaim: (key) => remoteBroadcast.tryClaim(key),
      onMessage: (listener) => {
        const remote = remoteBroadcast.onMessage((event) => {
          if (event.channel !== "state:task-groups") listener(event);
        });
        const local = controllerBroadcast.onMessage((event) => {
          if (event.channel === "state:task-groups") listener(event);
        });
        return {
          dispose: () => {
            remote.dispose();
            local.dispose();
          },
        };
      },
    });
  }
  // 手机连接远端 attachment 时仍投影窗口 Local Host 的身份，不为远端工作区另建登录 owner。
  const enterpriseIdentity = params.sourceServices?.getOptional(IEnterpriseIdentityService);
  if (enterpriseIdentity) services.register(IEnterpriseIdentityService, enterpriseIdentity);
  const registrationKeys = new Set(REMOTE_WORKSPACE_RPC_REGISTRATIONS.map(([key]) => key));
  const missing = [
    ...REMOTE_WORKSPACE_RPC_CHANNELS.filter((key) => !registrationKeys.has(key)),
    ...REMOTE_WORKSPACE_RPC_REGISTRATIONS.filter(
      ([, descriptor]) =>
        services.getOptional(descriptor as ServiceDescriptor<unknown>) === undefined,
    ).map(([key]) => key),
  ];
  if (missing.length > 0) {
    throw new Error(`Remote workspace RPC registration incomplete: ${missing.join(", ")}`);
  }
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningExecutor);
  return services;
}

export interface RemoteWorkspaceServiceCollection {
  readonly services: ServiceCollection;
  disposeAndWait(): Promise<void>;
}

export function createRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  sourceServices: ServiceCollection;
  createReportingRemoteZCodeTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentSessionService: <T extends object>(service: T) => T;
  promptAttachmentTransferService: IPromptAttachmentTransferService;
  runtimePreferencesBridge: {
    onError: (error: unknown) => void;
  };
}): RemoteWorkspaceServiceCollection {
  assertLegacyRemoteWorkspaceRpcContract(params.connectionServices);
  const localSettingService = createSettingService();
  const localCredentialService = createCredentialService();
  const localAccountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService: localCredentialService,
  });
  const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
    const settings = await localSettingService.get();
    return {
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
      caCertPath: settings.httpProxyCaCertPath,
    };
  });
  const localApiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
  });
  // 广播 listener 属于窗口 Local Host；远端路由只借用，不能每次重连另加一个无法回收的 listener。
  const localBroadcastService = params.sourceServices.get(IBroadcastService);
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const localOAuthCredentialRepo = new OAuthCredentialRepo(localCredentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // remote workspace host 读写的是本机 OAuth 凭据。
      // 损坏恢复必须和 local host 一样清理 Start/Coding Plan 派生 provider，避免手机 remote 残留旧 key。
      await Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      );
    },
  });
  const localAccountProviderCredentialService = createAccountProviderCredentialService({
    async loadOAuthAccessToken(family) {
      const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await localOAuthCredentialRepo.loadTokenSet(providerId))?.accessToken ?? null;
    },
    // desktop-attached remote 只复用本机已解析或旧存储中的 Key；远端刷新仍由本机正式账号链负责。
    resolveProviderMaterial: async () => null,
  });
  const readLocalAccountProviderSettings = async () => {
    const settings = await localSettingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
    };
  };
  const loadLocalAccountIdentity = async (family: ProviderFamilyDomain) => {
    const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await localOAuthCredentialRepo.loadUserProfile(providerId))?.id ?? null;
  };
  const localAccountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readLocalAccountProviderSettings,
          loadAccountIdentity: loadLocalAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => localOAuthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanMaterial(providerId, family, rejectedProjectTokenFingerprint) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await localOAuthCredentialRepo.loadUserProfile(oauthProviderId))
          ?.id;
        if (!accountIdentity) return null;
        return localAccountProviderCredentialService.loadCodingPlanMaterial({
          providerId,
          family,
          accountIdentity,
          rejectedProjectTokenFingerprint,
        });
      },
      resolveTeamPlanMaterial: async (access, rejectedProjectTokenFingerprint) => {
        const accountIdentity = await loadLocalAccountIdentity(access.family);
        if (!accountIdentity) return null;
        return resolveAccountTeamPlanRuntimeMaterial({
          apiClient: localApiClient,
          credentialService: localCredentialService,
          access,
          accountIdentity,
          rejectedProjectTokenFingerprint,
        });
      },
    }),
  );
  const localCodingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient: localApiClient,
    credentialService: localCredentialService,
  });
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore: localAccountProviderCredentialStore,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // 远端 workspace 的分享也必须使用真实 API；本地 Mock 仅用于单测，不生成无法跨进程访问的链接。
    apiClient: localApiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async () =>
      (await localCredentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() || null,
  });
  const conversationShareService = new ConversationShareService({
    zcodeAgentService: params.connectionServices.zcodeAgentService,
    client: conversationShareClient,
    artifactSource: createRemoteConversationShareArtifactSource(
      params.connectionServices.fileService,
    ),
  });
  const reportingRemoteZCodeTaskService = params.createReportingRemoteZCodeTaskService(
    params.connectionServices.zcodeTaskService,
  );
  // 手机 remote 的 replayable mirror 在 reporting wrapper 中发布用户消息；
  // 附件物化必须包在 reporting 外层，确保 mirror 和真正发给远端 agent 的 prompt 使用同一份远端路径。
  const remoteZCodeTaskService = params.createRemotePromptAttachmentTaskService(
    reportingRemoteZCodeTaskService,
  );
  const remoteZCodeSessionService = params.createRemotePromptAttachmentSessionService(
    params.connectionServices.zcodeSessionService,
  );
  const remoteProviderProvisioningService =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);

  // desktop-attached remote 的 Agent 运行在远端，但 app-global 设置权威仍在
  // desktop shared Host。通过窄化的 runtime-preferences 请求原路返回，避免远端读取自己的 setting。
  const { onError } = params.runtimePreferencesBridge;
  let disposed = false;
  const turnPresentationController = new AbortController();
  let disposal: Promise<void> | undefined;
  const runtimePreferencesEvent =
    params.connectionServices.zcodeAgentService.onDynamicSessionRuntimePreferencesRequest();
  const runtimePreferencesSubscription = runtimePreferencesEvent((request) => {
    if (disposed) return;
    const startedAt = Date.now();
    const requestContext = {
      event: "zcode_protocol.runtime_preferences.host_request_received",
      module: "desktop.host.remote_workspace",
      requestId: request.requestId,
      scope: request.scope,
      sessionId: request.sessionId,
    };
    // 诊断：Agent 侧超时只能说明没有拿到响应；这里记录 Host 是否收到请求，
    // 用“收到但无 response”区分 transport 丢包和设置读取卡住。
    runtimePreferencesLogger.info(
      undefined,
      "runtime preferences host request received",
      requestContext,
    );
    void (async () => {
      const trackStage = <T>(stage: string, promise: Promise<T>): Promise<T> => {
        const stageStartedAt = Date.now();
        return promise.then(
          (value) => {
            runtimePreferencesLogger.debug(undefined, "runtime preferences host stage completed", {
              ...requestContext,
              durationMs: Math.max(0, Date.now() - stageStartedAt),
              stage,
            });
            return value;
          },
          (error: unknown) => {
            runtimePreferencesLogger.warn(undefined, "runtime preferences host stage failed", {
              ...requestContext,
              durationMs: Math.max(0, Date.now() - stageStartedAt),
              error: error instanceof Error ? error.message : String(error),
              stage,
            });
            throw error;
          },
        );
      };
      let resolution:
        | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
        | { status: "failed"; message: string };
      try {
        // 与本地 Host 同源：固定预算不依赖配置网关，远程/手机偏好响应不再串行等待网络。
        const settings = await trackStage("settings", localSettingService.get());
        if (disposed) return;
        const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
        let presentation:
          | Awaited<ReturnType<typeof readEnterpriseIdentityTurnPresentation>>
          | undefined;
        if (request.scope === "turn-presentation") {
          const identity = params.sourceServices.getOptional(IEnterpriseIdentityService);
          if (!identity) throw new Error("enterprise_identity_changed");
          else {
            const before = await identity.getView();
            if (disposed) return;
            presentation = await readEnterpriseIdentityTurnPresentation(
              identity,
              turnPresentationController.signal,
            );
            if (disposed) return;
            const after = await identity.getView();
            if (
              params.sourceServices.getOptional(IEnterpriseIdentityService) !== identity ||
              before.revision !== after.revision
            )
              throw new Error("enterprise_identity_changed");
          }
        }
        resolution = {
          status: "resolved",
          preferences: {
            askUserQuestionAutoResolutionEnabled:
              settings.askUserQuestionAutoResolutionEnabled !== false,
            nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
            toolSearchMode: settings.toolSearchMode ?? "off",
            memoryEnabled: settings.memoryEnabled === true,
            modelContextBudgetStrategy,
            ...presentation,
            // remote workspace 与本地 Host 保持同一 scope 边界，首次执行不得再次等待 client config。
            ...(request.scope === "user-execution" && settings.integratedTerminalShell
              ? { integratedTerminalShell: settings.integratedTerminalShell }
              : {}),
          },
        };
      } catch (error) {
        resolution = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
        runtimePreferencesLogger.warn(undefined, "runtime preferences host resolution failed", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: resolution.message,
        });
      }
      // 设置成功/失败都可能晚于连接回收；关闭 fence 后不能再向已释放远端发送一次 RPC。
      if (disposed) return;
      // 只把设置读取失败编码为 -32603；发送失败交给最终 onError 记录，不能重试同一请求。
      await params.connectionServices.zcodeAgentService.respondSessionRuntimePreferences({
        requestId: request.requestId,
        resolution,
      });
      runtimePreferencesLogger.info(undefined, "runtime preferences host response sent", {
        ...requestContext,
        durationMs: Math.max(0, Date.now() - startedAt),
        resolutionStatus: resolution.status,
      });
    })().catch((error: unknown) => {
      runtimePreferencesLogger.warn(undefined, "runtime preferences host response failed", {
        ...requestContext,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      onError(error);
    });
  });

  // Web 手机远控进入 SSH task 时只连到 remote workspace host，
  // 没有桌面 renderer 那层 `baseServices + remoteServices` 合并。
  // 因此这里为 remote workspace host 补齐本地全局 channel；文件、终端、ZCode Agent 仍来自远端，
  // 设置、凭据、OAuth、模型供应商和 settings-sync 继续读写本机配置。
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, localSettingService)
    .register(ICredentialService, createPublicCredentialService(localCredentialService))
    .register(IBroadcastService, localBroadcastService)
    .register(IZCodeTaskService, remoteZCodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, remoteZCodeSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(
      IOAuthService,
      createOAuthService(localCredentialService, {
        apiClient: localApiClient,
        onProviderLogout: handleOAuthProviderLogout,
      }),
    )
    // Provider/Model 事实属于目标 Environment。远端 workspace 的选择和设置视图
    // 必须直接读取远端 Registry，不能继续显示 Desktop 本地 Provider。
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient: localApiClient,
        accountRequestAuthService: localAccountRequestAuthService,
        credentialService: localCredentialService,
        zcodeAgentService: params.connectionServices.zcodeAgentService,
      }),
    )
    .register(ICodingPlanSubscriptionService, localCodingPlanSubscriptionService)
    .register(IClientConfigService, params.clientConfigService)
    // 场景目录属于 base Host 的显示投影，不为远程 Scope 再建匿名 HTTP owner。
    .register(IClientScenesService, params.sourceServices.get(IClientScenesService))
    // 远端 workspace 的项目级 skills/plugins/commands 位于 SSH/Docker 文件系统。
    // 这里必须透出远端服务，避免本机服务拿远端 workspacePath 去本机目录扫描。
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    // 远端设置页插件管理也必须打到远端 agent（插件目录在远端文件系统）。
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(ISubagentsService, createSubagentsService({ isDesktopRuntime: true }))
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, createMemoryService())
    .register(
      ISettingsSyncService,
      createSettingsSyncService({ settingService: localSettingService }),
    )
    .register(IPromptAttachmentTransferService, params.promptAttachmentTransferService);
  // 手机连接远端 attachment 时仍投影窗口 Local Host 的身份，不为远端工作区另建登录 owner。
  const enterpriseIdentity = params.sourceServices.getOptional(IEnterpriseIdentityService);
  if (enterpriseIdentity) services.register(IEnterpriseIdentityService, enterpriseIdentity);
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningService);
  return {
    services,
    disposeAndWait() {
      if (disposal) return disposal;
      disposed = true;
      turnPresentationController.abort();
      // 先缓存 completion 再执行 cleanup；并发和失败后的重复 dispose 共用同一结果。
      disposal = Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        try {
          runtimePreferencesSubscription.dispose();
        } catch (error) {
          errors.push(error);
        }
        try {
          await hostApiNetworkTransport.disposeAndWait();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Remote workspace view cleanup failed");
        }
      });
      return disposal;
    },
  };
}
