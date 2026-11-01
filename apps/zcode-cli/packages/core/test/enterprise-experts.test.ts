import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRootTraceContext,
  createSessionId,
  type EnterpriseToolAuthorizationRequest,
  type EnterpriseToolAuthorizationDecision,
} from "@zcode/contracts";
import type { EnterpriseSkillsCatalog } from "@zcode/shared";
import { loadEnterpriseExpertProfiles } from "../../bootstrap/src/enterprise-experts.js";

const traceContext = createRootTraceContext({ sessionId: createSessionId("expert-parent") });
const ownerKey = "c".repeat(64);

function body(input: { instructions: string; profession?: string }) {
  return {
    instructions: input.instructions,
    ...(input.profession ? { profession: input.profession } : {}),
  };
}
async function fixture(options: { bodies: unknown[]; names: string[] }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uwork-experts-")));
  const experts = [];
  for (const [index, content] of options.bodies.entries()) {
    const directory = join(root, content ? `asset-${index}` : `asset-${index}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "expert.json"), JSON.stringify(content));
    const checksum = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    experts.push({
      key: createHash("sha256")
        .update(JSON.stringify({ id: `expert-${index}`, kind: "expert", version: 1, checksum }))
        .digest("hex"),
      asset: { id: `expert-${index}`, kind: "expert" as const, version: 1, checksum },
      directory,
      name: options.names[index] ?? `Expert ${index}`,
      distributed: true,
    });
  }
  return { experts, root };
}

function catalogPort(value: EnterpriseSkillsCatalog): {
  reads: number;
  port: { readCatalog: () => Promise<EnterpriseSkillsCatalog> };
} {
  const state = { reads: 0 };
  return {
    get reads() {
      return state.reads;
    },
    port: {
      async readCatalog() {
        state.reads++;
        return value;
      },
    },
  };
}
function authorizationPort(denyAfter?: number) {
  const requests: EnterpriseToolAuthorizationRequest[] = [];
  let served = 0;
  return {
    requests,
    port: {
      async authorize(request: EnterpriseToolAuthorizationRequest) {
        requests.push(structuredClone(request));
        served++;
        const decision: EnterpriseToolAuthorizationDecision =
          denyAfter !== undefined && served > denyAfter
            ? { allowed: false, code: "enterprise_asset_denied" }
            : { allowed: true, code: "allowed" };
        return decision;
      },
    },
  };
}

test("enterprise experts become read-only profiles with before/after admission and the current owner key", async (t) => {
  const f = await fixture({
    bodies: [body({ instructions: "Controlled expert instructions", profession: "分析专家" })],
    names: ["Controlled Expert"],
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const catalog = catalogPort({
    status: "ready",
    ownerKey,
    allowFilesystem: true,
    personalSkills: false,
    dangerousSkills: false,
    assets: [],
    experts: f.experts,
    connectors: [],
  });
  const authorization = authorizationPort();
  const profiles = await loadEnterpriseExpertProfiles({
    authorization: authorization.port,
    catalog: catalog.port,
    sessionId: "controlled",
    traceContext,
    workspacePath: "/controlled",
  });
  assert.equal(catalog.reads, 1);
  assert.deepEqual(profiles, [
    {
      name: "Controlled Expert",
      description: "分析专家",
      source: "enterprise",
      systemPrompt: "Controlled expert instructions",
    },
  ]);
  assert.equal(profiles[0]!.path, undefined);
  assert.deepEqual(
    authorization.requests.map((request) => [request.phase, request.ownerKey]),
    [
      ["asset_load", ownerKey],
      ["asset_load", ownerKey],
    ],
    "body reads are preceded and followed by the current asset admission",
  );
  assert.equal(authorization.requests[0]!.asset?.asset.kind, "expert");
  assert.equal(authorization.requests[0]!.capability.assetGuarded, true);
});

test("a missing, denied or unmanaged catalog never fabricates experts or falls back to local behavior", async (t) => {
  const f = await fixture({
    bodies: [body({ instructions: "Controlled" })],
    names: ["Controlled"],
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const input = {
    sessionId: "controlled",
    traceContext,
    workspacePath: "/controlled",
  };
  assert.deepEqual(
    await loadEnterpriseExpertProfiles({
      ...input,
      catalog: catalogPort({ status: "unmanaged" }).port,
    }),
    [],
    "a catalog without admission keeps the standalone result",
  );
  const denied = await loadEnterpriseExpertProfiles({
    ...input,
    authorization: authorizationPort().port,
    catalog: catalogPort({ status: "denied", code: "enterprise_asset_denied" }).port,
  });
  assert.deepEqual(denied, []);
  const withoutCatalog = await loadEnterpriseExpertProfiles({
    ...input,
    authorization: authorizationPort().port,
  });
  assert.deepEqual(withoutCatalog, []);
});

test("revoked, tampered or late expert bodies never become profiles", async (t) => {
  const f = await fixture({
    bodies: [
      body({ instructions: "Kept" }),
      body({ instructions: "Tampered after materialization" }),
      body({ instructions: "Revoked before read" }),
    ],
    names: ["Kept", "Tampered", "Revoked"],
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  // 第二个资产在缓存校验后被替换：正文 checksum 不再匹配绑定。
  await writeFile(
    join(f.experts[1]!.directory, "expert.json"),
    JSON.stringify(body({ instructions: "Replaced content" })),
  );
  // 第三个资产在任何读取前就被拒绝：准入失败先于文件访问。
  const authorization = authorizationPort(3);
  const profiles = await loadEnterpriseExpertProfiles({
    authorization: authorization.port,
    catalog: catalogPort({
      status: "ready",
      ownerKey,
      allowFilesystem: true,
      personalSkills: false,
      dangerousSkills: false,
      assets: [],
      experts: f.experts,
      connectors: [],
    }).port,
    sessionId: "controlled",
    traceContext,
    workspacePath: "/controlled",
  });
  assert.deepEqual(
    profiles.map((profile) => profile.name),
    ["Kept"],
  );
  assert.equal(authorization.requests.length, 4);
});

test("reserved and duplicate expert names cannot shadow built-ins or each other", async (t) => {
  const f = await fixture({
    bodies: [
      body({ instructions: "General purpose override attempt" }),
      body({ instructions: "First duplicate" }),
      body({ instructions: "Second duplicate" }),
    ],
    names: ["general-purpose", "Duplicated", "Duplicated"],
  });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const authorization = authorizationPort();
  const profiles = await loadEnterpriseExpertProfiles({
    authorization: authorization.port,
    catalog: catalogPort({
      status: "ready",
      ownerKey,
      allowFilesystem: true,
      personalSkills: false,
      dangerousSkills: false,
      assets: [],
      experts: f.experts,
      connectors: [],
    }).port,
    sessionId: "controlled",
    traceContext,
    workspacePath: "/controlled",
  });
  assert.deepEqual(
    profiles.map((profile) => profile.name),
    ["Duplicated"],
  );
  assert.equal(
    profiles[0]!.systemPrompt,
    "First duplicate",
    "the first claimed name wins deterministically; later duplicates are dropped",
  );
  assert.equal(
    authorization.requests.length,
    2,
    "only the claimed duplicate is read; the reserved name never reaches admission",
  );
});
