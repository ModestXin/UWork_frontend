import { test } from "node:test";
import assert from "node:assert/strict";
import { createUWorkToolAuthorizationResolver } from "../src/enterprise-identity/uworkToolAuthorization.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";
import type { ZCodeEnterpriseToolAuthorizationParams } from "@zcode/shared";

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

const manifestRequest: ZCodeEnterpriseToolAuthorizationParams = {
  ...request,
  toolName: "ProjectMemoryManifestRead",
  input: { kind: "project-memory-manifest" },
  capability: {
    permission: "filesystem",
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
  },
};

test("Memory manifest release rechecks current filesystem permission with the original owner", async () => {
  const f = fixture();
  assert.deepEqual(await f.resolver.authorize(manifestRequest), {
    allowed: false,
    code: "enterprise_filesystem_denied",
  });
  f.policy({ allowFilesystem: true });
  const admitted = await f.resolver.authorize(manifestRequest);
  assert.match(admitted.ownerKey ?? "", /^[a-f0-9]{64}$/);
  const release = {
    ...manifestRequest,
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

test("Memory manifest bytes cannot borrow a newly allowed member or missing dispatch proof", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  const first = await f.resolver.authorize(manifestRequest);
  f.replaceOwner();
  const second = await f.resolver.authorize(manifestRequest);
  assert.notEqual(first.ownerKey, second.ownerKey);
  const calls = f.counts();
  for (const ownerKey of [first.ownerKey, undefined])
    assert.deepEqual(
      await f.resolver.authorize({ ...manifestRequest, phase: "before_result", ownerKey }),
      { allowed: false, code: "enterprise_identity_changed" },
    );
  assert.equal(f.counts(), calls, "reject stale or missing owner before current-owner HTTP");
  assert.deepEqual(
    await f.resolver.authorize({
      ...manifestRequest,
      phase: "before_result",
      ownerKey: second.ownerKey,
    }),
    second,
  );
});

test("Memory manifest release preserves explicit UCAS behavior and denies managed mode changes", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  const admitted = await f.resolver.authorize(manifestRequest);
  f.configure({ backend: "ucas" });
  const calls = f.counts();
  assert.deepEqual(
    await f.resolver.authorize({
      ...manifestRequest,
      phase: "before_result",
      ownerKey: admitted.ownerKey,
    }),
    { allowed: false, code: "enterprise_identity_changed" },
  );
  for (const phase of ["before_dispatch", "before_result"] as const)
    assert.deepEqual(await f.resolver.authorize({ ...manifestRequest, phase }), {
      allowed: true,
      code: "not_managed",
    });
  assert.equal(f.counts(), calls, "unmanaged does not send enterprise credentials or policy HTTP");
  f.configure({ backend: "uwork" });
  assert.deepEqual(await f.resolver.authorize({ ...manifestRequest, phase: "before_result" }), {
    allowed: false,
    code: "enterprise_identity_changed",
  });
});

test("the Host rejects malformed Memory manifest metadata, capability and phase before policy HTTP", async () => {
  const f = fixture();
  f.policy({ allowShell: true, allowFilesystem: true, allowNetwork: true });
  const invalid: ZCodeEnterpriseToolAuthorizationParams[] = [
    ...[
      null,
      {},
      { kind: "file" },
      { kind: "project-memory-manifest", path: "/controlled/MEMORY.md" },
      { kind: "project-memory-manifest", body: "SYNTHETIC_PRIVATE_MEMORY_BODY" },
      { kind: "project-memory-manifest", metadata: {} },
    ].map((input) => ({ ...manifestRequest, input })),
    ...(["before_hooks", "native_execution", "network_request", "asset_load"] as const).map(
      (phase) => ({ ...manifestRequest, phase }),
    ),
    { ...manifestRequest, capability: { ...manifestRequest.capability, permission: "read" } },
    { ...manifestRequest, capability: { ...manifestRequest.capability, readOnly: false } },
    { ...manifestRequest, capability: { ...manifestRequest.capability, destructive: true } },
    {
      ...manifestRequest,
      capability: { ...manifestRequest.capability, sideEffectScope: "workspace" },
    },
    {
      ...manifestRequest,
      capability: { ...manifestRequest.capability, networkGuarded: false },
    },
    { ...manifestRequest, ownerKey: "a".repeat(64) },
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
        ...manifestRequest,
        toolName,
        phase: "before_result",
        ownerKey: "a".repeat(64),
      }),
      { allowed: false, code: "enterprise_capability_unsupported" },
    );
  assert.equal(f.counts(), 0);
});

test("Memory manifest result admission fails closed after logout or unavailable policy", async () => {
  for (const failure of ["logout", "unavailable"] as const) {
    const f = fixture();
    f.policy({ allowFilesystem: true });
    const admitted = await f.resolver.authorize(manifestRequest);
    if (failure === "logout") f.logout();
    else f.reject(503);
    const result = await f.resolver.authorize({
      ...manifestRequest,
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

test("unknown tool names retain generic filesystem dispatch while the fixed manifest consumer stays internal", async () => {
  const f = fixture();
  f.policy({ allowFilesystem: true });
  const request = {
    ...manifestRequest,
    toolName: "ArbitraryExistingFilesystemTool",
    input: { existing: true },
  };
  assert.equal((await f.resolver.authorize(request)).allowed, true);
  assert.deepEqual(
    await f.resolver.authorize({ ...request, phase: "before_result", ownerKey: "a".repeat(64) }),
    { allowed: false, code: "enterprise_capability_unsupported" },
  );
});
