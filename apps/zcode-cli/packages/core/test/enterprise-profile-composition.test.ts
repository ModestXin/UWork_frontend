import assert from "node:assert/strict";
import { test } from "node:test";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAgentProfiles, type AgentProfile } from "../src/subagent/profile.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { loadEnterpriseExpertProfileOutcome } from "../../bootstrap/src/enterprise-experts.js";
import { composeEnterpriseSubagentProfiles } from "../../bootstrap/src/enterprise-subagent-profiles.js";

const personal: AgentProfile = {
  name: "Same Name",
  source: "user",
  description: "Personal",
  systemPrompt: "personal",
};
const enterprise: AgentProfile = { ...personal, source: "enterprise", systemPrompt: "approved" };
const base = {
  sessionId: "composition",
  workspacePath: "/controlled",
  traceContext: createRootTraceContext(),
};
const authorization = { authorize: async () => ({ allowed: true, code: "allowed" }) };

test("the final managed registry never substitutes a personal profile for a revoked enterprise name", () => {
  const outcome = { managed: true, personalProfilesAllowed: true, profiles: [enterprise] };
  const input = {
    outcome,
    local: [personal],
    plugins: [{ ...personal, name: "plugin:Same Name" }],
    injected: [{ ...personal, source: "enterprise" as const }],
  };
  const profiles = normalizeAgentProfiles(composeEnterpriseSubagentProfiles(input));
  assert.equal(profiles.find((p) => p.name === "Same Name")?.systemPrompt, "approved");
  assert.equal(profiles.find((p) => p.name === "personal:user:Same Name")?.source, "user");
  assert.equal(profiles.find((p) => p.name === "personal:plugin:plugin:Same Name")?.source, "user");
  assert.equal(profiles.find((p) => p.name === "personal:runtime:Same Name")?.source, "user");
  const revoked = normalizeAgentProfiles(
    composeEnterpriseSubagentProfiles({ ...input, outcome: { ...outcome, profiles: [] } }),
  );
  assert.equal(
    revoked.some((p) => p.name === "Same Name"),
    false,
  );
  assert.equal(
    revoked.some((p) => p.name === "personal:user:Same Name"),
    true,
  );
  const denied = normalizeAgentProfiles(
    composeEnterpriseSubagentProfiles({
      ...input,
      outcome: { ...outcome, personalProfilesAllowed: false, profiles: [] },
    }),
  );
  assert.equal(
    denied.some((p) => p.source === "user" || p.source === "project"),
    false,
  );
  assert.equal(
    denied.some((p) => p.name === "general-purpose"),
    true,
  );
  assert.equal(
    denied.some((p) => p.name === "Explore"),
    true,
  );
});

test("standalone composition retains the prior names and source behavior", () => {
  assert.deepEqual(
    composeEnterpriseSubagentProfiles({ local: [personal], plugins: [], injected: [] }),
    [personal],
  );
});

test("one catalog read supplies the complete personal profile allowance", async () => {
  for (const flags of [
    [true, true, true],
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ]) {
    let reads = 0;
    const value = await loadEnterpriseExpertProfileOutcome({
      ...base,
      authorization,
      catalog: {
        readCatalog: async () => {
          reads++;
          return {
            status: "ready",
            ownerKey: "a".repeat(64),
            allowFilesystem: flags[0]!,
            personalSkills: flags[1]!,
            dangerousSkills: flags[2]!,
            assets: [],
            experts: [],
            connectors: [],
          };
        },
      },
    });
    assert.equal(reads, 1);
    assert.equal(value.managed, true);
    assert.equal(value.personalProfilesAllowed, flags.every(Boolean));
  }
});

test("missing required ports and failed managed catalogs cannot become standalone permission", async () => {
  const required = await loadEnterpriseExpertProfileOutcome({ ...base, required: true });
  assert.deepEqual(required, { managed: true, personalProfilesAllowed: false, profiles: [] });
  assert.equal(
    (await loadEnterpriseExpertProfileOutcome({ ...base, authorization })).personalProfilesAllowed,
    false,
  );
  assert.equal(
    (
      await loadEnterpriseExpertProfileOutcome({
        ...base,
        authorization,
        catalog: {
          readCatalog: async () => {
            throw Error("offline");
          },
        },
      })
    ).personalProfilesAllowed,
    false,
  );
  assert.equal(
    (
      await loadEnterpriseExpertProfileOutcome({
        ...base,
        authorization,
        catalog: {
          readCatalog: async () => ({ status: "denied", code: "enterprise_asset_denied" }),
        },
      })
    ).personalProfilesAllowed,
    false,
  );
  assert.equal(
    (
      await loadEnterpriseExpertProfileOutcome({
        ...base,
        authorization,
        catalog: { readCatalog: async () => ({ status: "unmanaged" }) },
      })
    ).managed,
    false,
  );
});

test("a cancelled ready response cannot publish personal permission", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await loadEnterpriseExpertProfileOutcome({
    ...base,
    authorization,
    signal: controller.signal,
    catalog: {
      readCatalog: async () => ({
        status: "ready",
        ownerKey: "a".repeat(64),
        allowFilesystem: true,
        personalSkills: true,
        dangerousSkills: true,
        assets: [],
        experts: [],
        connectors: [],
      }),
    },
  });
  assert.deepEqual(outcome, { managed: true, personalProfilesAllowed: false, profiles: [] });
});

test("reserved prefix variants are rejected before any expert body access", async () => {
  let admissions = 0;
  const names = [
    "personal:user:Same Name",
    "ＰＥＲＳＯＮＡＬ：user:Same Name",
    "per-sonal:user:Same Name",
    "p_e_r_s_o_n_a_l:user:Same Name",
  ];
  const outcome = await loadEnterpriseExpertProfileOutcome({
    ...base,
    authorization: {
      authorize: async () => {
        admissions++;
        throw Error("Must not read reserved profile");
      },
    },
    catalog: {
      readCatalog: async () => ({
        status: "ready",
        ownerKey: "a".repeat(64),
        allowFilesystem: true,
        personalSkills: true,
        dangerousSkills: true,
        assets: [],
        experts: names.map((name, index) => ({
          name,
          distributed: true,
          key: "a".repeat(64),
          asset: {
            id: `reserved-${index}`,
            version: 1,
            kind: "expert" as const,
            checksum: "a".repeat(64),
          },
          directory: "/controlled/not-readable",
        })),
        connectors: [],
      }),
    },
  });
  assert.equal(admissions, 0);
  assert.deepEqual(outcome.profiles, []);
});

test("the actual Core registry requires exact personal selection while keeping standalone fuzzy names", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uwork-profile-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const port = createExploreSubagentPort({
    profiles: composeEnterpriseSubagentProfiles({
      outcome: { managed: true, personalProfilesAllowed: true, profiles: [] },
      local: [personal],
      plugins: [],
      injected: [],
    }),
    outputRootDir: root,
    emitParentEvent: async () => {},
    runExploreAgent: async (request) => {
      calls++;
      return { response: "controlled", traceId: request.traceContext.traceId, events: [] };
    },
  });
  const request = {
    sessionId: createSessionId("composition"),
    parentToolCallId: "controlled",
    agentType: "ＰＥＲＳＯＮＡＬ：user:Same_Name",
    description: "controlled",
    prompt: "controlled",
    workingDirectory: root,
    workspaceRoot: root,
    trace: base.traceContext,
  };
  await assert.rejects(port.run(request), /not found/);
  assert.equal(calls, 0);
  await port.run({ ...request, agentType: "personal:user:Same Name" });
  assert.equal(calls, 1);
  const standalone = createExploreSubagentPort({
    profiles: [personal],
    outputRootDir: root,
    emitParentEvent: async () => {},
    runExploreAgent: async (request) => {
      calls++;
      return { response: "controlled", traceId: request.traceContext.traceId, events: [] };
    },
  });
  await standalone.run({ ...request, agentType: "same_name" });
  assert.equal(calls, 2);
});
