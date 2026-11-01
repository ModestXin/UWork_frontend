import { test } from "node:test";
import assert from "node:assert/strict";
import { createUWorkToolAuthorizationResolver } from "../src/enterprise-identity/uworkToolAuthorization.js";
import { UWorkBackendSessionError } from "../src/enterprise-identity/backendSessionContract.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";
import type { ZCodeEnterpriseToolAuthorizationParams } from "@zcode/shared";
import {
  createEnterpriseIdentityService,
  disposeEnterpriseIdentityService,
} from "../src/enterprise-identity/enterpriseIdentityService.js";
import { readEnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";
import { createSharedIdentitySessionStore } from "../src/enterprise-identity/identitySessionStore.js";

const origin = "https://backend.example.test";
const request: ZCodeEnterpriseToolAuthorizationParams = {
  requestId: "controlled-request",
  toolCallId: "controlled-call",
  sessionId: "controlled-session",
  toolName: "Read",
  workspace: { workspaceKey: "/controlled", workspacePath: "/controlled" },
  workingDirectory: "/controlled",
  phase: "before_dispatch",
  input: { file_path: "/controlled/example.txt" },
  capability: { permission: "read", readOnly: true, destructive: false, sideEffectScope: "none" },
};
function fixture() {
  let config: { backend: "uwork" | "ucas"; apiBaseUrl: string } | undefined = {
    backend: "uwork",
    apiBaseUrl: origin,
  };
  let authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: new AbortController().signal,
    session: {
      token: "synthetic-only",
      issuerOrigin: origin,
      expiresAt: Date.now() + 60000,
      profile: { id: "member", tenantId: "tenant", provider: "wecom", displayName: "Controlled" },
    },
  };
  let requests = 0;
  let duringFetch: (() => void) | undefined;
  let status = 200;
  let personal: { models: boolean; skills?: boolean; connectors: boolean } | undefined;
  let security = {
    allowShell: false,
    allowFilesystem: false,
    allowNetwork: true,
    dangerousSkills: false,
    allowedDomains: [] as string[],
  };
  const resolver = createUWorkToolAuthorizationResolver({
    resolveConfig: async () => config,
    readAuthority: () => authority,
    readPersistedSession: async () => ({
      revision: authority.revision,
      session: authority.session,
    }),
    fetchImpl: async (input, init) => {
      requests++;
      assert.equal(new URL(String(input)).origin, origin);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-only");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), { action: "execution", channel: "local" });
      duringFetch?.();
      return Response.json(
        status === 200
          ? { tenantId: "tenant", allowed: true, security, ...(personal ? { personal } : {}) }
          : { error: { code: "CONTROLLED_REJECTION" } },
        { status },
      );
    },
  });
  return {
    resolver,
    counts: () => requests,
    configure: (patch: { backend?: "uwork" | "ucas"; apiBaseUrl?: string }) =>
      (config = { backend: "uwork", apiBaseUrl: origin, ...config, ...patch }),
    removeConfig: () => {
      config = undefined;
    },
    policy: (patch: Partial<typeof security>) => (security = { ...security, ...patch }),
    personal: (value: typeof personal) => {
      personal = value;
    },
    during: (fn: () => void) => (duringFetch = fn),
    reject: (value: number) => (status = value),
    logout: () => {
      authority = { ...authority, generation: authority.generation + 1, session: null };
    },
    replaceOwner: () => {
      authority = {
        ...authority,
        generation: authority.generation + 1,
        revision: authority.revision + 1,
        session: {
          ...authority.session!,
          profile: { ...authority.session!.profile, id: "other-member" },
        },
      };
    },
  };
}

test("resolved personal agent prompts require current personal, filesystem and dangerous allowances", async () => {
  const f = fixture();
  const candidate: ZCodeEnterpriseToolAuthorizationParams = {
    ...request,
    toolName: "PersonalAgentProfileLoad",
    input: {},
    capability: {
      permission: "personal_agent",
      readOnly: true,
      destructive: false,
      sideEffectScope: "none",
    },
  };
  f.policy({ allowFilesystem: true, dangerousSkills: true });
  assert.equal((await f.resolver.authorize(candidate)).code, "enterprise_personal_agents_denied");
  f.personal({ models: false, skills: true, connectors: false });
  const allowed = await f.resolver.authorize(candidate);
  assert.equal(allowed.allowed, true);
  assert.equal(typeof allowed.ownerKey, "string");
  f.personal({ models: false, skills: false, connectors: false });
  assert.equal((await f.resolver.authorize(candidate)).code, "enterprise_personal_agents_denied");
  f.personal({ models: false, skills: true, connectors: false });
  f.policy({ allowFilesystem: false });
  assert.equal((await f.resolver.authorize(candidate)).code, "enterprise_filesystem_denied");
  f.policy({ allowFilesystem: true, dangerousSkills: false });
  assert.equal((await f.resolver.authorize(candidate)).code, "enterprise_personal_agents_denied");
  f.personal({ models: false, connectors: false });
  assert.equal((await f.resolver.authorize(candidate)).allowed, false);
  f.configure({ backend: "ucas" });
  assert.deepEqual(await f.resolver.authorize(candidate), { allowed: true, code: "not_managed" });
});

test("the Host evaluates current security even for a declared read-only tool", async () => {
  const f = fixture();
  assert.deepEqual(await f.resolver.authorize(request), {
    allowed: false,
    code: "enterprise_filesystem_denied",
  });
  f.policy({ allowFilesystem: true });
  const allowed = await f.resolver.authorize(request);
  assert.deepEqual(allowed, { allowed: true, code: "allowed", ownerKey: allowed.ownerKey });
  assert.match(allowed.ownerKey ?? "", /^[a-f0-9]{64}$/);
  assert.equal(f.counts(), 2);
});

test("the Host keeps unmanaged UCAS behavior without reading or sending identity credentials", async () => {
  const f = fixture();
  f.configure({ backend: "ucas" });
  assert.deepEqual(await f.resolver.authorize(request), { allowed: true, code: "not_managed" });
  assert.equal(f.counts(), 0);
});

test("builtin Read result release binds the dispatch owner and rechecks current filesystem policy", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  const dispatch = await f.resolver.authorize(request);
  assert.match(dispatch.ownerKey ?? "", /^[a-f0-9]{64}$/);
  const release = { ...request, phase: "before_result" as const, ownerKey: dispatch.ownerKey };
  assert.equal((await f.resolver.authorize(release)).allowed, true);
  f.policy({ allowFilesystem: false });
  assert.equal((await f.resolver.authorize(release)).code, "enterprise_filesystem_denied");
});

const attachmentRequest: ZCodeEnterpriseToolAuthorizationParams = {
  ...request,
  toolName: "PromptAttachmentRead",
  input: { path: "/controlled/owned.txt", kind: "file" },
  capability: {
    permission: "filesystem",
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
  },
};

const memoryIndexRequest: ZCodeEnterpriseToolAuthorizationParams = {
  ...request,
  toolName: "ProjectMemoryIndexRead",
  input: { kind: "project-memory-index" },
  capability: {
    permission: "filesystem",
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
  },
};

test("Memory index release rechecks current filesystem permission with the original owner", async () => {
  const f = fixture();
  assert.deepEqual(await f.resolver.authorize(memoryIndexRequest), {
    allowed: false,
    code: "enterprise_filesystem_denied",
  });
  f.policy({ allowFilesystem: true });
  const admitted = await f.resolver.authorize(memoryIndexRequest);
  assert.match(admitted.ownerKey ?? "", /^[a-f0-9]{64}$/);
  const release = {
    ...memoryIndexRequest,
    phase: "before_result" as const,
    ownerKey: admitted.ownerKey,
  };
  assert.deepEqual(await f.resolver.authorize(release), admitted);
  f.policy({ allowFilesystem: false });
  assert.deepEqual(await f.resolver.authorize(release), {
    allowed: false,
    code: "enterprise_filesystem_denied",
  });
  assert.equal(f.counts(), 4, "both phases consume current backend execution policy");
});

test("Memory bytes cannot borrow a newly allowed member or missing dispatch proof", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  const first = await f.resolver.authorize(memoryIndexRequest);
  f.replaceOwner();
  const second = await f.resolver.authorize(memoryIndexRequest);
  assert.notEqual(first.ownerKey, second.ownerKey);
  const calls = f.counts();
  for (const ownerKey of [first.ownerKey, undefined])
    assert.deepEqual(
      await f.resolver.authorize({ ...memoryIndexRequest, phase: "before_result", ownerKey }),
      { allowed: false, code: "enterprise_identity_changed" },
    );
  assert.equal(f.counts(), calls, "reject stale or missing owner before current-owner HTTP");
  assert.deepEqual(
    await f.resolver.authorize({
      ...memoryIndexRequest,
      phase: "before_result",
      ownerKey: second.ownerKey,
    }),
    second,
  );
});

test("Memory release preserves explicit UCAS behavior and denies managed mode changes", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  const admitted = await f.resolver.authorize(memoryIndexRequest);
  f.configure({ backend: "ucas" });
  const calls = f.counts();
  assert.deepEqual(
    await f.resolver.authorize({
      ...memoryIndexRequest,
      phase: "before_result",
      ownerKey: admitted.ownerKey,
    }),
    { allowed: false, code: "enterprise_identity_changed" },
  );
  for (const phase of ["before_dispatch", "before_result"] as const)
    assert.deepEqual(await f.resolver.authorize({ ...memoryIndexRequest, phase }), {
      allowed: true,
      code: "not_managed",
    });
  assert.equal(f.counts(), calls, "unmanaged does not send enterprise credentials or policy HTTP");
  f.configure({ backend: "uwork" });
  assert.deepEqual(await f.resolver.authorize({ ...memoryIndexRequest, phase: "before_result" }), {
    allowed: false,
    code: "enterprise_identity_changed",
  });
});

test("the Host rejects malformed Memory metadata, capability and phase before policy HTTP", async () => {
  const f = fixture();
  f.policy({ allowShell: true, allowFilesystem: true, allowNetwork: true });
  const invalid: ZCodeEnterpriseToolAuthorizationParams[] = [
    ...[
      null,
      {},
      { kind: "file" },
      { kind: "project-memory-index", path: "/controlled/MEMORY.md" },
      { kind: "project-memory-index", body: "SYNTHETIC_PRIVATE_MEMORY_BODY" },
      { kind: "project-memory-index", metadata: {} },
    ].map((input) => ({ ...memoryIndexRequest, input })),
    ...(["before_hooks", "native_execution", "network_request", "asset_load"] as const).map(
      (phase) => ({ ...memoryIndexRequest, phase }),
    ),
    { ...memoryIndexRequest, capability: { ...memoryIndexRequest.capability, permission: "read" } },
    { ...memoryIndexRequest, capability: { ...memoryIndexRequest.capability, readOnly: false } },
    { ...memoryIndexRequest, capability: { ...memoryIndexRequest.capability, destructive: true } },
    {
      ...memoryIndexRequest,
      capability: { ...memoryIndexRequest.capability, sideEffectScope: "workspace" },
    },
    {
      ...memoryIndexRequest,
      capability: { ...memoryIndexRequest.capability, networkGuarded: false },
    },
    { ...memoryIndexRequest, ownerKey: "a".repeat(64) },
  ];
  for (const candidate of invalid)
    assert.deepEqual(await f.resolver.authorize(candidate), {
      allowed: false,
      code: "enterprise_capability_unsupported",
    });
  assert.equal(f.counts(), 0);
  for (const toolName of ["ProjectMemoryRead", "ArbitraryFilesystemConsumer", "Write"])
    assert.deepEqual(
      await f.resolver.authorize({
        ...memoryIndexRequest,
        toolName,
        phase: "before_result",
        ownerKey: "a".repeat(64),
      }),
      { allowed: false, code: "enterprise_capability_unsupported" },
    );
  assert.equal(f.counts(), 0);
});

test("Memory result admission fails closed after logout or unavailable policy", async () => {
  for (const failure of ["logout", "unavailable"] as const) {
    const f = fixture();
    f.policy({ allowFilesystem: true });
    const admitted = await f.resolver.authorize(memoryIndexRequest);
    if (failure === "logout") f.logout();
    else f.reject(503);
    const result = await f.resolver.authorize({
      ...memoryIndexRequest,
      phase: "before_result",
      ownerKey: admitted.ownerKey,
    });
    assert.deepEqual(result, {
      allowed: false,
      code: failure === "logout" ? "enterprise_identity_changed" : "enterprise_policy_unavailable",
    });
    assert.equal(f.counts(), failure === "logout" ? 1 : 2);
  }
});

test("attachment release rechecks the original member filesystem policy with managed owner proof", async () => {
  const f = fixture();
  assert.equal(
    (await f.resolver.authorize(attachmentRequest)).code,
    "enterprise_filesystem_denied",
  );
  f.policy({ allowFilesystem: true });
  const dispatch = await f.resolver.authorize(attachmentRequest);
  assert.match(dispatch.ownerKey ?? "", /^[a-f0-9]{64}$/);
  const release = {
    ...attachmentRequest,
    phase: "before_result" as const,
    ownerKey: dispatch.ownerKey,
  };
  assert.equal((await f.resolver.authorize(release)).allowed, true);
  f.policy({ allowFilesystem: false });
  assert.equal((await f.resolver.authorize(release)).code, "enterprise_filesystem_denied");
});

test("attachment results cannot borrow another member or lose managed proof while UCAS stays compatible", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  const first = await f.resolver.authorize(attachmentRequest);
  f.replaceOwner();
  const second = await f.resolver.authorize(attachmentRequest);
  assert.notEqual(first.ownerKey, second.ownerKey);
  const calls = f.counts();
  for (const ownerKey of [first.ownerKey, undefined])
    assert.deepEqual(
      await f.resolver.authorize({ ...attachmentRequest, phase: "before_result", ownerKey }),
      { allowed: false, code: "enterprise_identity_changed" },
    );
  assert.equal(f.counts(), calls, "proof mismatch precedes current-owner HTTP");
  f.configure({ backend: "ucas" });
  assert.deepEqual(
    await f.resolver.authorize({
      ...attachmentRequest,
      phase: "before_result",
      ownerKey: second.ownerKey,
    }),
    { allowed: false, code: "enterprise_identity_changed" },
  );
  assert.deepEqual(await f.resolver.authorize({ ...attachmentRequest, phase: "before_result" }), {
    allowed: true,
    code: "not_managed",
  });
  f.configure({ backend: "uwork" });
  assert.equal(
    (await f.resolver.authorize({ ...attachmentRequest, phase: "before_result" })).allowed,
    false,
  );
});

test("the Host rejects malformed attachment capability, phase and input before policy HTTP", async () => {
  const f = fixture();
  f.policy({ allowShell: true, allowFilesystem: true });
  const invalid: ZCodeEnterpriseToolAuthorizationParams[] = [
    ...(["before_hooks", "native_execution", "network_request", "asset_load"] as const).map(
      (phase) => ({ ...attachmentRequest, phase }),
    ),
    { ...attachmentRequest, capability: { ...attachmentRequest.capability, permission: "read" } },
    { ...attachmentRequest, capability: { ...attachmentRequest.capability, readOnly: false } },
    { ...attachmentRequest, capability: { ...attachmentRequest.capability, destructive: true } },
    {
      ...attachmentRequest,
      capability: { ...attachmentRequest.capability, sideEffectScope: "workspace" },
    },
    { ...attachmentRequest, capability: { ...attachmentRequest.capability, assetGuarded: true } },
    {
      ...attachmentRequest,
      input: { path: "/controlled/owned.txt", kind: "file", body: "SYNTHETIC_NOT_AUTH_METADATA" },
    },
    { ...attachmentRequest, input: { path: "zcode-artifact://owned", kind: "file" } },
  ];
  for (const candidate of invalid)
    assert.deepEqual(await f.resolver.authorize(candidate), {
      allowed: false,
      code: "enterprise_capability_unsupported",
    });
  assert.equal(f.counts(), 0);
});

test("a missing or different Read owner cannot borrow a newly allowed identity", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  const first = await f.resolver.authorize(request);
  f.replaceOwner();
  const second = await f.resolver.authorize(request);
  assert.equal(second.allowed, true);
  assert.notEqual(first.ownerKey, second.ownerKey);
  const requests = f.counts();
  for (const ownerKey of [first.ownerKey, undefined]) {
    const result = await f.resolver.authorize({ ...request, phase: "before_result", ownerKey });
    assert.deepEqual(result, { allowed: false, code: "enterprise_identity_changed" });
  }
  assert.equal(f.counts(), requests, "owner mismatch must precede the new owner's policy HTTP");
});

test("Read result release rejects both managed mode transitions and non-Read stage misuse", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  const managed = await f.resolver.authorize(request);
  f.configure({ backend: "ucas" });
  assert.equal(
    (await f.resolver.authorize({ ...request, phase: "before_result", ownerKey: managed.ownerKey }))
      .allowed,
    false,
  );
  assert.deepEqual(await f.resolver.authorize({ ...request, phase: "before_result" }), {
    allowed: true,
    code: "not_managed",
  });
  f.configure({ backend: "uwork" });
  assert.equal((await f.resolver.authorize({ ...request, phase: "before_result" })).allowed, false);
  const calls = f.counts();
  assert.equal(
    (
      await f.resolver.authorize({
        ...request,
        phase: "before_result",
        toolName: "Write",
        ownerKey: managed.ownerKey,
      })
    ).allowed,
    false,
  );
  assert.equal(f.counts(), calls);
});

test("private transport error details do not change the established execution-denial contract", async () => {
  for (const code of [
    "enterprise_response_limit",
    "enterprise_response_private",
    "enterprise_request_limit",
  ]) {
    const resolver = createUWorkToolAuthorizationResolver({
      backendSession: {
        async run() {
          throw new UWorkBackendSessionError(code);
        },
      },
    });
    assert.deepEqual(await resolver.authorize(request), {
      allowed: false,
      code: "enterprise_policy_unavailable",
    });
  }
});

test("an established managed Host cannot lose its gate when configuration disappears, even after logout", async () => {
  const f = fixture();
  assert.equal((await f.resolver.authorize(request)).allowed, false);
  f.removeConfig();
  assert.deepEqual(await f.resolver.authorize(request), {
    allowed: false,
    code: "enterprise_configuration_changed",
  });
  f.logout();
  assert.deepEqual(await f.resolver.authorize(request), {
    allowed: false,
    code: "enterprise_configuration_changed",
  });
  f.configure({ backend: "ucas" });
  assert.deepEqual(await f.resolver.authorize(request), { allowed: true, code: "not_managed" });
  assert.equal(f.counts(), 1);
});

test("logout during backend HTTP cannot return a late authorization", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  f.during(f.logout);
  assert.deepEqual(await f.resolver.authorize(request), {
    allowed: false,
    code: "enterprise_identity_changed",
  });
});

test("an endpoint switch during backend HTTP cannot authorize the previous profile", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  f.during(() => f.configure({ apiBaseUrl: "https://other.example.test" }));
  assert.deepEqual(await f.resolver.authorize(request), {
    allowed: false,
    code: "enterprise_configuration_changed",
  });
  assert.deepEqual(await f.resolver.authorize(request), {
    allowed: false,
    code: "enterprise_identity_changed",
  });
  assert.equal(f.counts(), 1, "an old token must never be sent to the replacement endpoint");
});

test("remote subscription, channel and authentication rejection cannot produce local execution", async () => {
  const f = fixture();
  for (const status of [401, 403, 402, 503]) {
    f.reject(status);
    assert.equal((await f.resolver.authorize(request)).allowed, false);
  }
});

test("native shell execution does not pretend to enforce unsupported mixed network/filesystem isolation", async () => {
  const f = fixture(),
    native = {
      ...request,
      phase: "native_execution" as const,
      toolName: "Bash",
      capability: { ...request.capability, permission: "bash", sideEffectScope: "system" as const },
    };
  assert.deepEqual(await f.resolver.authorize(native), {
    allowed: false,
    code: "enterprise_shell_denied",
  });
  f.policy({ allowShell: true, allowFilesystem: true, allowNetwork: false });
  assert.deepEqual(await f.resolver.authorize(native), {
    allowed: false,
    code: "enterprise_capability_unsupported",
  });
  f.policy({ allowNetwork: true });
  assert.equal((await f.resolver.authorize(native)).allowed, true);
});

test("network tool targets are checked against the current domain allowlist", async () => {
  const f = fixture();
  f.policy({ allowedDomains: ["approved.example.test"] });
  const web = {
    ...request,
    toolName: "WebFetch",
    input: { url: "https://unapproved.example.test" },
    capability: {
      ...request.capability,
      permission: "network",
      sideEffectScope: "network" as const,
      networkGuarded: true,
    },
  };
  assert.equal((await f.resolver.authorize(web)).code, "enterprise_domain_denied");
  web.input.url = "https://approved.example.test/document";
  assert.equal((await f.resolver.authorize(web)).allowed, true);
  f.policy({ allowNetwork: false });
  assert.equal((await f.resolver.authorize(web)).code, "enterprise_network_denied");
});

test("unknown capabilities cannot fall through to allow under restrictive enterprise policy", async () => {
  const f = fixture();
  f.policy({ allowNetwork: false });
  const result = await f.resolver.authorize({
    ...request,
    toolName: "FuturePlugin",
    capability: { ...request.capability, permission: "custom" },
  });
  assert.deepEqual(result, { allowed: false, code: "enterprise_capability_unsupported" });
});

test("domain-restricted tools require a policy-aware network adapter rather than only an approved initial URL", async () => {
  const f = fixture();
  f.policy({ allowedDomains: ["approved.example.test"] });
  const result = await f.resolver.authorize({
    ...request,
    toolName: "WebFetch",
    input: { url: "https://approved.example.test" },
    capability: { ...request.capability, permission: "network", sideEffectScope: "network" },
  });
  assert.deepEqual(result, { allowed: false, code: "enterprise_capability_unsupported" });
});

test("a shared logout tombstone fences a second owner even when its peer notification is delayed", async () => {
  const values = new Map<string, string>(),
    credentials = {
      load: async (key: string) => values.get(key) ?? null,
      save: async (key: string, value: string) => {
        values.set(key, value);
      },
      delete: async (key: string) => {
        values.delete(key);
      },
    };
  const store = createSharedIdentitySessionStore(credentials, async (operation) => operation());
  const session = {
    token: "synthetic-only",
    issuerOrigin: origin,
    expiresAt: Date.now() + 60000,
    profile: {
      id: "member",
      tenantId: "tenant",
      provider: "wecom" as const,
      displayName: "Controlled",
    },
  };
  const adapter = {
    listOrganizations: () => [{ id: "tenant" }],
    resolveOrganization: () => ({ id: "tenant" }),
    start: async () => ({
      id: "controlled-state",
      authorizationUrl: "https://login.example.test/?state=controlled-state",
      callbackUrl: "https://auth.example.test/callback",
      expiresAt: Date.now() + 60000,
    }),
    complete: async () => session,
    restore: async () => session,
  };
  const first = createEnterpriseIdentityService({ credentials, sessionStore: store, adapter }),
    second = createEnterpriseIdentityService({ credentials, sessionStore: store, adapter });
  try {
    const attempt = await first.beginLogin();
    await first.completeLogin(
      attempt.id,
      "https://auth.example.test/callback?code=controlled-code&state=controlled-state",
    );
    await second.restoreSession();
    const resolver = createUWorkToolAuthorizationResolver({
      resolveConfig: async () => ({ backend: "uwork", apiBaseUrl: origin }),
      readAuthority: () => readEnterpriseIdentityAuthority(second),
      readPersistedSession: () => store.read(),
      fetchImpl: async () => {
        await first.logout();
        assert.ok(
          readEnterpriseIdentityAuthority(second)?.session,
          "the second owner deliberately has not received a peer notification",
        );
        assert.equal((await store.read()).session, null);
        return Response.json({
          tenantId: "tenant",
          allowed: true,
          security: {
            allowShell: false,
            allowFilesystem: true,
            allowNetwork: true,
            dangerousSkills: false,
            allowedDomains: [],
          },
        });
      },
    });
    assert.deepEqual(await resolver.authorize(request), {
      allowed: false,
      code: "enterprise_identity_changed",
    });
  } finally {
    await disposeEnterpriseIdentityService(first);
    await disposeEnterpriseIdentityService(second);
  }
});
