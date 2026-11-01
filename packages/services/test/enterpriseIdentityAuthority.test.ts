import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEnterpriseIdentityService,
  disposeEnterpriseIdentityService,
} from "../src/enterprise-identity/enterpriseIdentityService.js";
import { readEnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";

test("identity authority is invalidated synchronously before a delayed logout tombstone can be persisted", async () => {
  const values = new Map<string, string>();
  let block = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const callback = "https://auth.example.test/callback",
    state = "controlled-state";
  const session = {
    token: "synthetic-only",
    expiresAt: Date.now() + 60000,
    profile: {
      id: "controlled-member",
      tenantId: "controlled-tenant",
      provider: "wecom" as const,
      displayName: "Controlled",
    },
  };
  const service = createEnterpriseIdentityService({
    credentials: {
      load: async (key) => values.get(key) ?? null,
      save: async (key, value) => {
        if (block) await gate;
        values.set(key, value);
      },
      delete: async (key) => {
        if (block) await gate;
        values.delete(key);
      },
    },
    adapter: {
      listOrganizations: () => [{ id: session.profile.tenantId }],
      resolveOrganization: () => ({ id: session.profile.tenantId }),
      start: async () => ({
        id: state,
        callbackUrl: callback,
        authorizationUrl: `https://login.example.test/?state=${state}`,
        expiresAt: Date.now() + 60000,
      }),
      complete: async () => session,
      restore: async () => session,
    },
  });
  try {
    const attempt = await service.beginLogin();
    await service.completeLogin(attempt.id, `${callback}?code=controlled-code&state=${state}`);
    const before = readEnterpriseIdentityAuthority(service)!;
    assert.equal(before.session?.token, session.token);
    assert.equal(before.signal.aborted, false);
    assert.ok(values.size > 0);
    block = true;
    const logout = service.logout();
    const during = readEnterpriseIdentityAuthority(service)!;
    assert.equal(before.signal.aborted, true);
    assert.ok(during.generation > before.generation);
    assert.equal(during.session, null);
    assert.ok(
      values.size > 0,
      "persistent credentials are deliberately still stale during this assertion",
    );
    release();
    await logout;
  } finally {
    release();
    await disposeEnterpriseIdentityService(service);
  }
  assert.equal(readEnterpriseIdentityAuthority(service), undefined);
});
