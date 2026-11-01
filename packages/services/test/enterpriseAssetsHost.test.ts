import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import { createEnterpriseAssetsHost } from "../src/enterprise-assets/enterpriseAssetsHost.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";
import { attachEnterpriseAssetsLifecycle } from "../src/enterprise-assets/enterpriseAssetsLifecycle.js";
import { Emitter } from "@zcode/rpc";
import type { EnterpriseIdentityView } from "@zcode/shared";

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "uwork-assets-host-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let owner = new AbortController();
  let authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: owner.signal,
    session: {
      token: "synthetic-private",
      issuerOrigin: "https://backend.example.test",
      expiresAt: Date.now() + 60000,
      profile: { id: "member", tenantId: "tenant", provider: "wecom", displayName: "Controlled" },
    },
  };
  let content = {
    files: [{ path: "SKILL.md", content: "# Controlled version one" }],
    highRisk: false,
  };
  let version = 1,
    visible = true,
    enabled = true,
    downloads = 0,
    personal = false,
    dangerous = false;
  let duringDownload: (() => void) | undefined;
  let executionReads = 0,
    duringExecution: ((count: number) => void) | undefined;
  let holdAsset: (() => Promise<void>) | undefined;
  let stallDownload = false,
    entered!: () => void;
  const downloading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manifest = () => ({
    id: "controlled",
    kind: "skill",
    name: "Controlled",
    version,
    checksum: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    distributed: true,
  });
  const backendSession = createUWorkBackendSession({
    resolveConfig: async () => ({ backend: "uwork", apiBaseUrl: "https://backend.example.test" }),
    readAuthority: () => authority,
    readPersistedSession: async () => ({
      revision: authority.revision,
      session: authority.session,
    }),
    fetchImpl: async (input, options) => {
      const path = new URL(String(input)).pathname;
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer synthetic-private");
      assert.ok(new Headers(options?.headers).get("x-zcode-trace-id"));
      if (path.endsWith("/assets")) return Response.json({ items: visible ? [manifest()] : [] });
      if (path.endsWith("/download")) {
        if (stallDownload) {
          entered();
          await new Promise<void>(() => {});
        }
        downloads++;
        const item = manifest();
        const downloaded = {
          id: item.id,
          kind: item.kind,
          version: item.version,
          checksum: item.checksum,
          content,
        };
        duringDownload?.();
        return Response.json(downloaded);
      }
      const body = JSON.parse(String(options?.body));
      if (body.action === "execution") {
        executionReads++;
        duringExecution?.(executionReads);
        return Response.json({
          allowed: true,
          tenantId: "tenant",
          personal: { skills: personal },
          security: {
            allowFilesystem: true,
            allowShell: false,
            allowNetwork: false,
            dangerousSkills: dangerous,
            allowedDomains: [],
          },
        });
      }
      const allowed =
        enabled &&
        visible &&
        body.assetVersion === version &&
        body.assetChecksum === manifest().checksum &&
        (!content.highRisk || dangerous);
      const held = holdAsset;
      holdAsset = undefined;
      await held?.();
      return Response.json({
        allowed,
        tenantId: "tenant",
      });
    },
  });
  const host = createEnterpriseAssetsHost({ backendSession, storageDirectory: directory });
  t.after(() => host.disposeAllAndWait());
  return {
    host,
    anotherHost: () => {
      const other = createEnterpriseAssetsHost({ backendSession, storageDirectory: directory });
      t.after(() => other.disposeAllAndWait());
      return other;
    },
    holdNextAsset: () => {
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      holdAsset = async () => {
        entered();
        await held;
      };
      return { release, waiting };
    },
    readAuthority: () => authority,
    directory,
    downloads: () => downloads,
    revoke: () => {
      visible = false;
      enabled = false;
    },
    update: () => {
      version++;
      content = { ...content, files: [{ path: "SKILL.md", content: "# Controlled version two" }] };
    },
    risk: () => {
      content = { ...content, highRisk: true };
    },
    personal: (value: boolean) => {
      personal = value;
      dangerous = value;
    },
    duringDownload: (value: () => void) => {
      duringDownload = value;
    },
    duringExecution: (value: (count: number) => void) => {
      duringExecution = value;
    },
    stall: () => {
      stallDownload = true;
      return downloading;
    },
    logout: () => {
      owner.abort();
      authority = { ...authority, generation: 2, session: null };
    },
    replaceLogin: () => {
      owner.abort();
      owner = new AbortController();
      authority = {
        ...authority,
        generation: authority.generation + 1,
        revision: authority.revision + 1,
        signal: owner.signal,
      };
    },
  };
}

test(
  "an older reconciliation cannot prune another Host's newer successful selection",
  { timeout: 2000 },
  async (t) => {
    const f = await fixture(t),
      other = f.anotherHost(),
      held = f.holdNextAsset();
    t.after(held.release);
    const older = f.host.readCatalog("older-catalog");
    await held.waiting;
    f.update();
    const newer = await other.readCatalog("newer-catalog");
    if (newer.status !== "ready") throw new Error("Expected newer catalog");
    held.release();
    assert.equal((await older).status, "denied");
    assert.match(
      await readFile(join(newer.assets[0]!.directory, "SKILL.md"), "utf8"),
      /version two/,
    );
    assert.equal((await other.authorizeAsset(newer.assets[0]!, "newer-load")).allowed, true);
  },
);

test("Host reconciliation installs, verifies reuse, updates and revokes its current profile cache", async (t) => {
  const f = await fixture(t);
  const first = await f.host.readCatalog("controlled-trace");
  if (first.status !== "ready") throw new Error("Expected managed catalog");
  assert.equal(first.assets.length, 1);
  assert.match(await readFile(join(first.assets[0]!.directory, "SKILL.md"), "utf8"), /version one/);
  assert.equal((await f.host.authorizeAsset(first.assets[0]!, "controlled-trace")).allowed, true);
  await f.host.readCatalog("controlled-trace");
  assert.equal(f.downloads(), 1);
  f.update();
  const second = await f.host.readCatalog("controlled-trace");
  if (second.status !== "ready") throw new Error("Expected updated catalog");
  assert.notEqual(second.assets[0]!.key, first.assets[0]!.key);
  assert.equal((await f.host.authorizeAsset(first.assets[0]!, "controlled-trace")).allowed, false);
  f.revoke();
  const revoked = await f.host.readCatalog("controlled-trace");
  if (revoked.status !== "ready") throw new Error("Expected current empty catalog");
  assert.equal(revoked.assets.length, 0);
  assert.equal((await f.host.authorizeAsset(second.assets[0]!, "controlled-trace")).allowed, false);
  await assert.rejects(() => readFile(join(second.assets[0]!.directory, "SKILL.md")));
});

test("a catalog owner binding cannot cross logout/relogin even when the same profile is allowed again", async (t) => {
  const f = await fixture(t);
  f.personal(true);
  const first = await f.host.readCatalog("controlled-before-login");
  if (first.status !== "ready") throw new Error("Expected first owner catalog");
  const key = (first as typeof first & { ownerKey: string }).ownerKey;
  f.replaceLogin();
  assert.equal(
    (await f.host.authorizeAsset(undefined, "controlled-old-personal", undefined, key)).allowed,
    false,
  );
  assert.equal(
    (await f.host.authorizeAsset(first.assets[0]!, "controlled-old-asset", undefined, key)).allowed,
    false,
  );
  const second = await f.host.readCatalog("controlled-after-login");
  if (second.status !== "ready") throw new Error("Expected replacement owner catalog");
  const next = (second as typeof second & { ownerKey: string }).ownerKey;
  assert.notEqual(next, key);
  assert.equal(
    (await f.host.authorizeAsset(undefined, "controlled-new-personal", undefined, next)).allowed,
    true,
  );
});

test(
  "existing identity events prewarm the Host and current logout clears only its touched cache",
  { timeout: 1000 },
  async (t) => {
    const f = await fixture(t),
      events = new Emitter<EnterpriseIdentityView>();
    let installed!: () => void;
    const warm = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const readCatalog = f.host.readCatalog.bind(f.host);
    let catalog: Awaited<ReturnType<typeof readCatalog>> | undefined;
    f.host.readCatalog = async (...arguments_) => {
      const result = await readCatalog(...arguments_);
      catalog = result;
      installed();
      return result;
    };
    const base = {
      revision: 1,
      configured: true,
      error: null,
      organizations: [],
      selectedOrgId: null,
    };
    const lifecycle = attachEnterpriseAssetsLifecycle({
      assets: f.host,
      readAuthority: f.readAuthority,
      identity: {
        onDidChange: events.event,
        getView: async () => ({
          ...base,
          status: "authenticated",
          pending: null,
          profile: f.readAuthority().session!.profile,
        }),
      },
    });
    await warm;
    if (catalog?.status !== "ready") throw new Error("Expected prewarmed catalog");
    const directory = catalog.assets[0]!.directory;
    let cleared!: () => void;
    const cleaning = new Promise<void>((resolve) => {
      cleared = resolve;
    });
    const clearCached = f.host.clearCached.bind(f.host);
    f.host.clearCached = async (...arguments_) => {
      await clearCached(...arguments_);
      cleared();
    };
    f.logout();
    events.fire({ ...base, revision: 2, status: "signed-out", profile: null, pending: null });
    await cleaning;
    await assert.rejects(() => readFile(join(directory, "SKILL.md")));
    await lifecycle.disposeAllAndWait();
    events.dispose();
  },
);

test("high-risk and personal skills require current explicit policies", async (t) => {
  const f = await fixture(t);
  f.risk();
  const denied = await f.host.readCatalog("controlled-trace");
  if (denied.status !== "ready") throw new Error("Expected empty managed catalog");
  assert.equal(denied.assets.length, 0);
  assert.equal(f.downloads(), 0);
  assert.equal((await f.host.authorizeAsset(undefined, "controlled-trace")).allowed, false);
  f.personal(true);
  assert.equal((await f.host.authorizeAsset(undefined, "controlled-trace")).allowed, true);
});

test("logout and manifest change during download cannot publish a late catalog", async (t) => {
  for (const mode of ["logout", "version"] as const) {
    const f = await fixture(t);
    f.duringDownload(mode === "logout" ? f.logout : f.update);
    const result = await f.host.readCatalog("controlled-trace");
    assert.equal(result.status, "denied");
    assert.ok(!JSON.stringify(result).includes("synthetic-private"));
  }
});

test("foreign directories and disposed Hosts cannot authorize cached assets", async (t) => {
  const f = await fixture(t),
    result = await f.host.readCatalog("controlled-trace");
  if (result.status !== "ready") throw new Error("Expected catalog");
  assert.equal(
    (
      await f.host.authorizeAsset(
        { ...result.assets[0]!, directory: f.directory },
        "controlled-trace",
      )
    ).allowed,
    false,
  );
  await f.host.disposeAllAndWait();
  assert.equal((await f.host.readCatalog("controlled-trace")).status, "denied");
});

test("a dangerous-skill policy revoked after cache verification cannot authorize high-risk bytes", async (t) => {
  const f = await fixture(t);
  f.risk();
  f.personal(true);
  const catalog = await f.host.readCatalog("controlled-trace");
  if (catalog.status !== "ready") throw new Error("Expected authorized high-risk catalog");
  f.duringExecution((count) => {
    if (count === 4) f.personal(false);
  });
  assert.equal(
    (await f.host.authorizeAsset(catalog.assets[0]!, "controlled-trace")).allowed,
    false,
  );
});

test(
  "Host disposal aborts an in-flight download without waiting for transport cooperation",
  { timeout: 1000 },
  async (t) => {
    const f = await fixture(t),
      entered = f.stall();
    const work = f.host.readCatalog("controlled-trace");
    await entered;
    await f.host.disposeAllAndWait();
    assert.equal((await work).status, "denied");
  },
);
