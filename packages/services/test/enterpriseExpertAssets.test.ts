import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import { createEnterpriseAssetsHost } from "../src/enterprise-assets/enterpriseAssetsHost.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";

const checksum = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "uwork-expert-assets-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new AbortController();
  const authority: EnterpriseIdentityAuthority = {
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
  const expert = { instructions: "Controlled expert", profession: "分析专家" };
  const skill = { files: [{ path: "SKILL.md", content: "# Controlled skill" }], highRisk: false };
  let visible = true;
  const downloads: string[] = [];
  const items = () => [
    {
      id: "expert-a",
      kind: "expert",
      name: "Controlled Expert",
      version: 1,
      checksum: checksum(expert),
      distributed: true,
    },
    {
      id: "skill-a",
      kind: "skill",
      name: "Controlled Skill",
      version: 1,
      checksum: checksum(skill),
      distributed: true,
    },
    // 服务端矩阵不会下发这些类型；即使被伪造进清单，Host 也必须拒绝缓存。
    {
      id: "playbook-a",
      kind: "playbook",
      name: "Controlled Playbook",
      version: 1,
      checksum: checksum({ markdown: "# Cookbook" }),
      distributed: true,
    },
    {
      id: "instruction-a",
      kind: "instruction",
      name: "Controlled Instruction",
      version: 1,
      checksum: checksum({ instructions: "Controlled" }),
      distributed: true,
    },
    {
      id: "connector-a",
      kind: "connector",
      name: "Controlled Connector",
      version: 1,
      checksum: checksum({ transport: "streamable-http", description: "Controlled" }),
      distributed: true,
    },
  ];
  const contentFor = (kind: string) =>
    kind === "expert" ? expert : kind === "skill" ? skill : undefined;
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
      if (path.endsWith("/assets")) return Response.json({ items: visible ? items() : [] });
      if (path.endsWith("/authorize")) {
        const body = JSON.parse(String(options?.body));
        if (body.action === "execution")
          return Response.json({
            allowed: true,
            tenantId: "tenant",
            personal: { skills: false },
            security: {
              allowFilesystem: true,
              allowShell: false,
              allowNetwork: false,
              dangerousSkills: false,
              allowedDomains: [],
            },
          });
        const item = items().find((candidate) => candidate.id === body.target);
        return Response.json({
          allowed:
            visible &&
            !!item &&
            body.assetVersion === item.version &&
            body.assetChecksum === item.checksum,
          tenantId: "tenant",
        });
      }
      const id = path.split("/").at(-2)!;
      const item = items().find((candidate) => candidate.id === id)!;
      downloads.push(item.id);
      // 与真实后端一致：下载响应只含绑定与内容，不含清单字段。
      return Response.json({
        id: item.id,
        kind: item.kind,
        version: item.version,
        checksum: item.checksum,
        content: contentFor(item.kind),
      });
    },
  });
  const host = createEnterpriseAssetsHost({ backendSession, storageDirectory: directory });
  t.after(() => host.disposeAllAndWait());
  return {
    host,
    directory,
    downloads,
    revoke: () => {
      visible = false;
    },
  };
}

test("the Host caches only kinds with a current client owner and exposes experts alongside skills", async (t) => {
  const f = await fixture(t);
  const catalog = await f.host.readCatalog("controlled-trace");
  if (catalog.status !== "ready") throw new Error(`Expected ready catalog: ${catalog.status}`);
  assert.deepEqual(
    catalog.assets.map((asset) => asset.asset.kind),
    ["skill"],
  );
  assert.deepEqual(
    catalog.experts.map((expert) => [expert.name, expert.asset.kind, expert.distributed]),
    [["Controlled Expert", "expert", true]],
  );
  assert.deepEqual(
    f.downloads,
    ["expert-a", "skill-a"],
    "playbook/instruction/connector never reach the private cache",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(catalog.experts[0]!.directory, "expert.json"), "utf8")),
    {
      instructions: "Controlled expert",
      profession: "分析专家",
    },
  );
  const entries = await readdir(f.directory);
  assert.equal(entries.filter((entry) => entry.endsWith("-playbook-a")).length, 0);

  const expert = catalog.experts[0]!;
  assert.equal((await f.host.authorizeAsset(expert, "controlled-load")).allowed, true);
  const swapped = {
    ...expert,
    asset: { ...expert.asset, kind: "skill" as const },
  };
  assert.equal((await f.host.authorizeAsset(swapped, "swapped-kind")).allowed, false);
  assert.equal(
    (await f.host.authorizeAsset(swapped, "swapped-kind")).code,
    "enterprise_assets_invalid",
  );
  const foreign = { ...expert, directory: join(expert.directory, "..") };
  assert.equal((await f.host.authorizeAsset(foreign, "foreign-directory")).allowed, false);
  f.revoke();
  assert.equal((await f.host.authorizeAsset(expert, "revoked-load")).allowed, false);
  const revoked = await f.host.readCatalog("controlled-trace");
  if (revoked.status !== "ready") throw new Error("Expected current empty catalog");
  assert.deepEqual([revoked.assets.length, revoked.experts.length], [0, 0]);
  await assert.rejects(() => readFile(join(expert.directory, "expert.json")));
});

test("one profile cache keeps skill and expert objects across a second reconcile", async (t) => {
  const f = await fixture(t);
  const first = await f.host.readCatalog("controlled-trace");
  if (first.status !== "ready") throw new Error("Expected ready catalog");
  const second = await f.host.readCatalog("controlled-trace");
  if (second.status !== "ready") throw new Error("Expected ready catalog");
  assert.equal(second.experts.length, 1);
  assert.equal(second.assets.length, 1);
  assert.deepEqual(
    f.downloads,
    ["expert-a", "skill-a"],
    "verified objects are reused, not re-downloaded",
  );
  assert.equal(
    (await f.host.authorizeAsset(second.experts[0]!, "controlled-load")).allowed,
    true,
    "the expert object was not pruned by the skill selection",
  );
  assert.equal((await f.host.authorizeAsset(second.assets[0]!, "controlled-load")).allowed, true);
});
