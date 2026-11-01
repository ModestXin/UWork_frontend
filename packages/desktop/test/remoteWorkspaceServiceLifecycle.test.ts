import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as services from "@zcode/services";
import * as shared from "@zcode/shared";
import { assertLegacyRemoteWorkspaceRpcContract } from "../src/host/legacyRemoteWorkspaceRpcContract.js";
import { createClientPresentationReader } from "../../services/src/enterprise-identity/clientPresentation.js";
import { createEnterpriseIdentityService } from "../../services/src/enterprise-identity/enterpriseIdentityService.js";
import {
  disposeEnterpriseIdentityService,
  readEnterpriseIdentityTurnPresentation,
} from "../../services/src/enterprise-identity/identityServiceLifecycle.js";
import { UWorkBackendSessionError } from "../../services/src/enterprise-identity/backendSessionContract.js";

type Row = Record<string, unknown>;
type Disposable = { dispose(): void };
type Composition = {
  services: services.ServiceCollection;
  disposeAndWait(): Promise<void>;
};
type ConnectionHandle = { dispose(): Promise<void> };
type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// These are source-level ownership tests, not transport or identity acceptance.
// Execute the exact private production function without importing Electron's
// process entry or adding a test-only export to the production surface.
function productionFunction<T>(file: string, name: string, bindings: Row): T {
  const path = new URL(`../src/host/${file}`, import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(declaration, `production function ${name} must exist`);
  const code = ts.transpileModule(
    `${declaration.getText(source).replace(/^export\s+/, "")}\n${name};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  bindings.AggregateError = AggregateError;
  bindings.Error = Error;
  bindings.process = { env: {}, pid: 1 };
  bindings.AbortController = AbortController;
  return runInNewContext(code, bindings) as T;
}

function compositionFixture(
  input: {
    subscriptionError?: Error;
    networkError?: Error;
    presentation?: shared.UWorkClientPresentation;
    readPresentation?: () => Promise<shared.UWorkClientPresentation>;
    getIdentityView?: () => Promise<{ revision: number }>;
    identityService?: services.IEnterpriseIdentityService;
  } = {},
) {
  const calls: string[] = [];
  const responses: Row[] = [];
  const errors: unknown[] = [];
  const settings = deferred<Row>();
  const network = deferred<void>();
  const localBroadcast = Object.freeze({ marker: "borrowed-window-broadcast" });
  const identity =
    input.identityService ??
    createEnterpriseIdentityService({
      credentials: { load: async () => null, save: async () => {}, delete: async () => {} },
      readClientPresentation: async () => {
        calls.push("presentation-read");
        return input.readPresentation
          ? input.readPresentation()
          : (input.presentation ?? { status: "unmanaged" });
      },
    });
  if (!input.identityService) after(() => disposeEnterpriseIdentityService(identity));
  if (input.getIdentityView) {
    const getView = identity.getView;
    identity.getView = async () => ({ ...(await getView()), ...(await input.getIdentityView!()) });
  }
  const scenes = Object.freeze({ marker: "borrowed-scenes-projection" });
  const sourceServices = new services.ServiceCollection()
    .register(services.IBroadcastService, localBroadcast as unknown as services.IBroadcastService)
    .register(
      services.IEnterpriseIdentityService,
      identity as unknown as services.IEnterpriseIdentityService,
    )
    .register(services.IClientScenesService, scenes as unknown as services.IClientScenesService);
  let listener!: (request: Row) => void;
  const noResource = () => ({});
  const connectionServices: Row = Object.fromEntries(
    [
      "fileService",
      "gitService",
      "gitCheckpointService",
      "systemService",
      "terminalService",
      "zcodeTaskService",
      "zcodeSessionService",
      "fileWatcherService",
      "skillsService",
      "skillSyncService",
      "mcpSyncService",
      "pluginSyncService",
      "pluginsService",
      "pluginManagementService",
      "commandsService",
      "hooksService",
      "modelSelectionService",
      "providerSettingsService",
    ].map((name) => [name, Object.freeze({ marker: `borrowed-${name}` })]),
  );
  connectionServices.zcodeAgentService = {
    onDynamicSessionRuntimePreferencesRequest:
      () =>
      (callback: typeof listener): Disposable => {
        listener = callback;
        return {
          dispose() {
            calls.push("unsubscribe");
            if (input.subscriptionError) throw input.subscriptionError;
          },
        };
      },
    respondSessionRuntimePreferences: async (response: Row) => {
      calls.push("remote-preferences-response");
      responses.push(response);
    },
  };
  const bindings: Row = {
    readEnterpriseIdentityTurnPresentation,
    ...services,
    ...shared,
    assertLegacyRemoteWorkspaceRpcContract,
    createSettingService: () => ({
      get: () => {
        calls.push("settings-read");
        return settings.promise;
      },
    }),
    createCredentialService: noResource,
    createPublicCredentialService: noResource,
    createAccountProviderCredentialStore: noResource,
    createAccountProviderCredentialService: noResource,
    createAccountProviderRequestAuthService: noResource,
    createAccountRequestAuthService: noResource,
    createNodeApiClient: noResource,
    createOAuthProviderLogoutHandler: noResource,
    createCodingPlanSubscriptionService: noResource,
    createOAuthService: noResource,
    createUsageStatsService: noResource,
    createClientScenesService: noResource,
    createSubagentsService: noResource,
    createMemoryService: noResource,
    createSettingsSyncService: noResource,
    createRemoteConversationShareArtifactSource: noResource,
    createRemoteProviderProvisioningExecutorFromWorkspace: noResource,
    registerRemoteProviderProvisioningExecutor: noResource,
    registerHostApiNetworkTransportForDispose: noResource,
    createBroadcastService: () => {
      calls.push("duplicate-broadcast-created");
      return {};
    },
    createHostApiNetworkTransport: () => ({
      fetch: () => {
        throw new Error("unit ownership fixture must never fetch");
      },
      disposeAndWait() {
        calls.push("network-close");
        if (input.networkError) return Promise.reject(input.networkError);
        return network.promise;
      },
    }),
    OAuthCredentialRepo: class {},
    ConversationShareHttpClient: class {},
    ConversationShareService: class {},
    resolveCurrentAccountAccess: noResource,
    resolveAccountTeamPlanRuntimeApiKey: noResource,
    runtimePreferencesLogger: {
      info: noResource,
      debug: noResource,
      warn: noResource,
    },
    ZCODE_JWT_TOKEN_KEY: "unused-unit-key",
  };
  const create = productionFunction<(params: Row) => Composition>(
    "remoteWorkspaceServiceCollection.ts",
    "createRemoteWorkspaceServiceCollection",
    bindings,
  );
  const clientConfig = Object.freeze({ marker: "borrowed-window-config" });
  const view = create({
    sourceServices,
    connectionServices,
    clientConfigService: clientConfig,
    parentPort: null,
    createReportingRemoteZCodeTaskService: (value: object) => value,
    createRemotePromptAttachmentTaskService: (value: object) => value,
    createRemotePromptAttachmentSessionService: (value: object) => value,
    promptAttachmentTransferService: {},
    runtimePreferencesBridge: {
      onError: (error: unknown) => errors.push(error),
    },
  });
  return {
    view,
    scenes,
    responses,
    calls,
    errors,
    settings,
    network,
    listener,
    sourceServices,
    localBroadcast,
    identity,
    clientConfig,
    connectionServices,
  };
}

test("remote routing view borrows window identity, broadcast and remote services", async () => {
  const f = compositionFixture();
  assert.equal(f.view.services.get(services.IBroadcastService), f.localBroadcast);
  assert.equal(f.view.services.get(services.IEnterpriseIdentityService), f.identity);
  assert.equal(f.view.services.get(services.IClientConfigService), f.clientConfig);
  assert.equal(
    f.view.services.get(services.ITerminalService),
    f.connectionServices.terminalService,
  );
  assert.equal(
    f.view.services.get(services.IZCodeAgentService),
    f.connectionServices.zcodeAgentService,
  );
  assert.equal(f.view.services.getOptional(services.IUcasGatewayService), undefined);
  const closing = f.view.disposeAndWait();
  f.network.resolve();
  await closing;
  assert.deepEqual(f.calls, ["unsubscribe", "network-close"]);
  assert.equal(f.sourceServices.get(services.IEnterpriseIdentityService), f.identity);
  assert.equal(f.sourceServices.get(services.IBroadcastService), f.localBroadcast);
  assert.equal(f.view.services.get(services.IClientScenesService), f.scenes);
});

test("remote turn-presentation metadata borrows the base identity's published Desktop flag", async () => {
  const f = compositionFixture({
    presentation: {
      status: "ready",
      version: 0,
      welcome: "",
      riskNotice: "Verify",
      riskPrefix: "AI",
      scenes: { status: "unsupported" },
      help: { status: "unsupported" },
      pluginStore: { status: "unsupported" },
      desktop: {
        status: "ready",
        version: 1,
        data: {
          desktopContextPrompt: { enabled: false },
          rendererActionTrace: { enabled: false, sampleRatio: 0, enabledGroups: [] },
        },
      },
    },
  });
  f.listener({ requestId: "owned-turn", scope: "turn-presentation", sessionId: "owned-session" });
  f.settings.resolve({});
  await new Promise<void>((done) => setImmediate(done));
  const resolution = f.responses[0]?.resolution as Row;
  assert.equal((resolution.preferences as Row).presentationSurface, "terminal");
  assert(f.calls.includes("presentation-read"));
  f.network.resolve();
  await f.view.disposeAndWait();
});

test("turn metadata resolved after the routing view is disposed cannot emit a late remote response", async () => {
  const pending = deferred<shared.UWorkClientPresentation>();
  const f = compositionFixture({ readPresentation: () => pending.promise });
  f.listener({
    requestId: "owned-late-turn",
    scope: "turn-presentation",
    sessionId: "owned-session",
  });
  f.settings.resolve({});
  await new Promise<void>((done) => setImmediate(done));
  assert(f.calls.includes("presentation-read"));
  const closing = f.view.disposeAndWait();
  f.network.resolve();
  await closing;
  pending.resolve({ status: "unmanaged" });
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(f.responses, []);
});

test("identity replacement during a borrowed turn read is a failure rather than a terminal metadata downgrade", async () => {
  let revision = 0;
  const f = compositionFixture({ getIdentityView: async () => ({ revision: ++revision }) });
  f.listener({
    requestId: "owned-owner-change",
    scope: "turn-presentation",
    sessionId: "owned-session",
  });
  f.settings.resolve({});
  await new Promise<void>((done) => setImmediate(done));
  const resolution = f.responses[0]?.resolution as Row;
  assert.equal(resolution.status, "failed");
  assert.equal(resolution.message, "enterprise_identity_changed");
  f.network.resolve();
  await f.view.disposeAndWait();
});

test("same-revision private configuration invalidation is a failed remote turn response", async () => {
  const identity = createEnterpriseIdentityService({
    credentials: { load: async () => null, save: async () => {}, delete: async () => {} },
    readClientPresentation: createClientPresentationReader({
      async run() {
        throw new UWorkBackendSessionError("enterprise_configuration_changed");
      },
    }),
  });
  const f = compositionFixture({ identityService: identity });
  try {
    const before = await identity.getView();
    f.listener({
      requestId: "owned-config-change",
      scope: "turn-presentation",
      sessionId: "owned-session",
    });
    f.settings.resolve({});
    await new Promise<void>((done) => setImmediate(done));
    assert.equal((await identity.getView()).revision, before.revision);
    const resolution = f.responses[0]?.resolution as Row;
    assert.equal(resolution.status, "failed");
    assert.equal(resolution.message, "enterprise_configuration_changed");
  } finally {
    f.network.resolve();
    await f.view.disposeAndWait();
    await disposeEnterpriseIdentityService(identity);
  }
});

test("concurrent view disposal shares one result and waits for owned network", async () => {
  const f = compositionFixture();
  const first = f.view.disposeAndWait();
  assert.equal(f.view.disposeAndWait(), first);
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  f.network.resolve();
  await first;
  assert.equal(f.view.disposeAndWait(), first);
  assert.deepEqual(f.calls, ["unsubscribe", "network-close"]);
});

for (const outcome of ["resolved", "rejected"] as const) {
  test(`settings ${outcome} after view disposal cannot emit a late remote response`, async () => {
    const f = compositionFixture();
    f.listener({
      requestId: "owned-unit-request",
      scope: "user-execution",
      sessionId: "owned-unit-session",
    });
    assert.deepEqual(f.calls, ["settings-read"]);
    const closing = f.view.disposeAndWait();
    f.network.resolve();
    await closing;
    if (outcome === "resolved") f.settings.resolve({});
    else f.settings.reject(new Error("owned-settings-failed"));
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(f.calls, ["settings-read", "unsubscribe", "network-close"]);
    assert.deepEqual(f.errors, []);
    f.listener({
      requestId: "stale-event",
      scope: "user-execution",
      sessionId: "owned-unit-session",
    });
    assert.deepEqual(f.calls, ["settings-read", "unsubscribe", "network-close"]);
  });
}

test("subscription failure still closes network and keeps both cleanup failures", async () => {
  const subscriptionError = new Error("owned-unsubscribe-failed");
  const networkError = new Error("owned-network-failed");
  const f = compositionFixture({ subscriptionError, networkError });
  const closing = f.view.disposeAndWait();
  assert.equal(f.view.disposeAndWait(), closing);
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [subscriptionError, networkError]);
    return true;
  });
  assert.equal(f.view.disposeAndWait(), closing);
  assert.deepEqual(f.calls, ["unsubscribe", "network-close"]);
});

function connectionFixture(failureStage?: "telemetry" | "view" | "transport" | "all") {
  const calls: string[] = [];
  const owner = Object.freeze({
    name: "validated-window-owner",
    get: () => ({}),
  });
  const unrelatedOwner = Object.freeze({
    name: "changed-window-global",
    get: () => ({}),
  });
  const connectReady = deferred<void>();
  const transportClosing = deferred<void>();
  const problems = {
    telemetry: new Error("owned-telemetry-failure"),
    view: new Error("owned-view-failure"),
    transport: new Error("owned-transport-failure"),
  };
  const problem = problems[failureStage === "all" || !failureStage ? "telemetry" : failureStage];
  let capturedSource: unknown;
  const bindings: Row = {
    activeServices: owner,
    IClientConfigService: {},
    activeSessionRealtimePort: undefined,
    parentPort: null,
    remoteMediaRangePreviewEnabled: false,
    requireActiveHostApiNetworkTransport: () => ({
      fetch: () => {
        throw new Error("no unit network");
      },
    }),
    resolveDesktopRemoteRuntimeNetwork: async () => undefined,
    setupRemoteConnection: async () => {
      await connectReady.promise;
      bindings.activeServices = unrelatedOwner;
      return { backend: {}, services: {} };
    },
    createRemotePromptAttachmentTransferService: () => ({}),
    createRemoteWorkspaceServiceCollection: (params: Row) => {
      capturedSource = params.sourceServices;
      return {
        services: {},
        async disposeAndWait() {
          calls.push("view");
          if (failureStage === "view" || failureStage === "all") throw problems.view;
        },
      };
    },
    registerHostServiceResourceTelemetry: () => ({
      dispose() {
        calls.push("telemetry");
        if (failureStage === "telemetry" || failureStage === "all") throw problems.telemetry;
      },
    }),
    resolveResourceTelemetryEnvironmentKey: () => "owned-unit-target",
    disposeServiceResourcesAndWait: () => {
      calls.push("borrowed-generic-dispose");
      throw new Error("borrowed services cannot be disposed");
    },
    disposeHostRemoteConnection: async () => {
      calls.push("transport");
      if (failureStage === "transport" || failureStage === "all") throw problems.transport;
      await transportClosing.promise;
    },
    logger: { warn() {} },
  };
  const create = productionFunction<(params: Row) => Promise<ConnectionHandle>>(
    "index.ts",
    "createWindowRemoteConnectionHandle",
    bindings,
  );
  const handleReady = create({
    target: { kind: "docker", container: "owned-unit" },
    remoteAssets: {},
    signal: new AbortController().signal,
  });
  connectReady.resolve();
  return {
    calls,
    handleReady,
    transportClosing,
    problem,
    problems,
    owner,
    capturedSource: () => capturedSource,
  };
}

test("connection disposal waits once and retains the validated source collection", async () => {
  const f = connectionFixture();
  const handle = await f.handleReady;
  assert.equal(f.capturedSource(), f.owner);
  const first = handle.dispose();
  void first.catch(() => {});
  assert.equal(handle.dispose(), first);
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(f.calls, ["view", "telemetry", "transport"]);
  f.transportClosing.resolve();
  await first;
  assert.equal(handle.dispose(), first);
});

test("connection disposal closes the view fence synchronously before cleanup can yield", async () => {
  const f = connectionFixture();
  const handle = await f.handleReady;
  const closing = handle.dispose();
  void closing.catch(() => {});
  assert.deepEqual(f.calls, ["view"]);
  f.transportClosing.resolve();
  await closing;
});

for (const stage of ["view", "telemetry", "transport"] as const) {
  test(`${stage} cleanup failure keeps later connection cleanup and shared rejection`, async () => {
    const f = connectionFixture(stage);
    const handle = await f.handleReady;
    const first = handle.dispose();
    void first.catch(() => {});
    assert.equal(handle.dispose(), first);
    f.transportClosing.resolve();
    await assert.rejects(first, (error: unknown) => error === f.problem);
    assert.equal(handle.dispose(), first);
    assert.deepEqual(f.calls, ["view", "telemetry", "transport"]);
  });
}

test("multiple connection cleanup failures preserve order and never repeat a stage", async () => {
  const f = connectionFixture("all");
  const handle = await f.handleReady;
  const closing = handle.dispose();
  assert.equal(handle.dispose(), closing);
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [f.problems.telemetry, f.problems.view, f.problems.transport]);
    return true;
  });
  assert.equal(handle.dispose(), closing);
  assert.deepEqual(f.calls, ["view", "telemetry", "transport"]);
});
