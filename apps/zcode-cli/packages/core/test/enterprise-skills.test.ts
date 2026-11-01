import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  createRootTraceContext,
  createSessionId,
  type EnterpriseToolAuthorizationRequest,
  type SkillContent,
  type SkillMetadata,
  type SkillPort,
} from "@zcode/contracts";
import type { EnterpriseSkillsCatalog } from "@zcode/shared";
import { withEnterpriseSkillAuthorization } from "../../adapters/src/skills/enterprise-skills.js";

const reference = {
  key: "a".repeat(64),
  asset: { id: "controlled", kind: "skill" as const, version: 1, checksum: "b".repeat(64) },
  directory: "/controlled/cache/content",
};
const traceContext = createRootTraceContext({ sessionId: createSessionId("parent") });
const request = {
  name: "enterprise:controlled",
  workingDirectory: "/controlled",
  trace: traceContext,
};
function metadata(directory: string, personal = false): SkillMetadata {
  return {
    name: personal ? "Personal" : "content",
    description: "Controlled metadata",
    path: join(directory, "SKILL.md"),
    directory,
    rootPath: directory,
    scope: personal ? "user" : "admin",
    source: personal ? "zcode" : "remote",
    safeToAutoLoad: true,
    frontmatterKeys: [],
  };
}
function body(value: SkillMetadata): SkillContent {
  return {
    metadata: value,
    content: "controlled body",
    baseDirectory: value.directory,
    bytesRead: 15,
    sizeBytes: 15,
    truncated: false,
  };
}
function fixture() {
  let catalog: EnterpriseSkillsCatalog = {
    status: "ready",
    ownerKey: "c".repeat(64),
    allowFilesystem: true,
    personalSkills: false,
    dangerousSkills: false,
    assets: [{ ...reference, name: "Controlled", distributed: true }],
    experts: [],
    connectors: [],
  };
  let allowed = true,
    personalReads = 0,
    enterpriseReads = 0;
  let duringLoad: (() => void) | undefined,
    foreign = false,
    mutateAdmission = false;
  let personal = metadata("/controlled/personal", true);
  const admissions: EnterpriseToolAuthorizationRequest[] = [],
    roots: unknown[] = [],
    sessions: string[] = [];
  const personalPort: SkillPort = {
    async discoverSkills(value) {
      personalReads++;
      roots.push(value.roots);
      return { skills: [personal], diagnostics: [], totalDiscovered: 1 };
    },
    async loadSkill(value) {
      personalReads++;
      roots.push(value.roots);
      duringLoad?.();
      return body(personal);
    },
  };
  const enterprisePort: SkillPort = {
    async discoverSkills(value) {
      enterpriseReads++;
      roots.push(value.roots);
      const item = metadata(foreign ? "/controlled/foreign" : value.roots![0]!.path);
      return { skills: [item], diagnostics: [], totalDiscovered: 1 };
    },
    async loadSkill(value) {
      enterpriseReads++;
      roots.push(value.roots);
      duringLoad?.();
      return body(metadata(value.roots![0]!.path));
    },
  };
  const authorization = {
    async authorize(value: EnterpriseToolAuthorizationRequest) {
      admissions.push(structuredClone(value));
      // 只有已落盘引用携带目录；连接器准入没有本地路径可伪造。
      if (mutateAdmission && value.asset && "directory" in value.asset)
        value.asset.directory = "/controlled/forged";
      return { allowed, code: allowed ? "allowed" : "enterprise_asset_denied" };
    },
  };
  const catalogPort = {
    async readCatalog(value: { sessionId: string }) {
      sessions.push(value.sessionId);
      return catalog;
    },
  };
  const context = {
    authorization,
    catalog: catalogPort,
    enterprisePort,
    sessionId: "parent",
    workspacePath: "/controlled",
    traceContext,
  };
  return {
    port: withEnterpriseSkillAuthorization(personalPort, context),
    personalPort,
    context,
    admissions,
    roots,
    sessions,
    counts: () => ({ personalReads, enterpriseReads }),
    setCatalog: (value: EnterpriseSkillsCatalog) => {
      catalog = value;
    },
    personal: (value: SkillMetadata) => {
      personal = value;
    },
    deny: () => {
      allowed = false;
    },
    duringLoad: (value: () => void) => {
      duringLoad = value;
    },
    foreign: () => {
      foreign = true;
    },
    mutate: () => {
      mutateAdmission = true;
    },
  };
}

test("guarded SkillPort loads only the exact enterprise root with before/after admission and current child trace", async () => {
  const f = fixture(),
    child = createSessionId("child");
  const result = await f.port.loadSkill({
    ...request,
    roots: [{ path: "/forged", scope: "user", source: "zcode", priority: 0 }],
    trace: { ...traceContext, sessionId: child },
  });
  assert.equal(f.port.enterpriseAssetGuarded, true);
  assert.equal(result.content, "controlled body");
  assert.equal(result.metadata.name, "Controlled");
  assert.equal(result.metadata.qualifiedName, "enterprise:controlled");
  assert.equal(f.counts().personalReads, 0);
  assert.equal(f.admissions.length, 4);
  for (const value of f.admissions) {
    assert.equal(value.phase, "asset_load");
    assert.deepEqual(value.asset, reference);
    assert.equal(value.sessionId, child);
    assert.equal(value.traceContext.traceId, traceContext.traceId);
  }
  assert.deepEqual(f.sessions, [child]);
  for (const value of f.roots)
    assert.deepEqual(value, [
      { path: reference.directory, scope: "admin", source: "remote", priority: 0 },
    ]);
});

test("denied catalogs, filesystem policy and missing private ports never fall back to personal reads", async () => {
  for (const catalog of [
    { status: "denied", code: "enterprise_subscription_inactive" },
    {
      status: "ready",
      ownerKey: "c".repeat(64),
      allowFilesystem: false,
      personalSkills: true,
      dangerousSkills: true,
      assets: [],
      experts: [],
      connectors: [],
    },
  ] satisfies EnterpriseSkillsCatalog[]) {
    const f = fixture();
    f.setCatalog(catalog);
    await assert.rejects(() => f.port.loadSkill(request), /enterprise_/);
    assert.deepEqual(f.counts(), { personalReads: 0, enterpriseReads: 0 });
  }
  const f = fixture();
  const partial = withEnterpriseSkillAuthorization(f.personalPort, {
    ...f.context,
    catalog: undefined,
  });
  await assert.rejects(() => partial.discoverSkills(request), /enterprise_policy_unavailable/);
  assert.equal(f.counts().personalReads, 0);
});

test("managed body reads reject invalid or unbounded byte budgets before adapter IO", async () => {
  for (const maxBytes of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1048577]) {
    const f = fixture();
    await assert.rejects(
      () => f.port.loadSkill({ ...request, maxBytes }),
      /enterprise_skill_size_invalid/,
    );
    assert.deepEqual(f.counts(), { personalReads: 0, enterpriseReads: 0 });
  }
});

test("a revoke after an actual body read rejects the late result without returning its content", async () => {
  const f = fixture();
  f.duringLoad(f.deny);
  await assert.rejects(
    () => f.port.loadSkill(request),
    (error: unknown) =>
      error instanceof Error &&
      /enterprise_asset_denied/.test(error.message) &&
      !error.message.includes("controlled body"),
  );
  assert.equal(f.counts().enterpriseReads, 2);
});

test("personal skills require both policies and cannot claim the reserved enterprise namespace", async () => {
  const f = fixture();
  f.setCatalog({
    status: "ready",
    ownerKey: "c".repeat(64),
    allowFilesystem: true,
    personalSkills: true,
    dangerousSkills: false,
    assets: [],
    experts: [],
    connectors: [],
  });
  assert.equal((await f.port.discoverSkills(request)).skills.length, 0);
  assert.equal(f.counts().personalReads, 0);
  f.setCatalog({
    status: "ready",
    ownerKey: "c".repeat(64),
    allowFilesystem: true,
    personalSkills: true,
    dangerousSkills: true,
    assets: [],
    experts: [],
    connectors: [],
  });
  assert.equal(
    (await f.port.loadSkill({ ...request, name: "Personal" })).content,
    "controlled body",
  );
  assert.equal(
    f.admissions.every((value) => value.asset === undefined),
    true,
  );
  f.personal({ ...metadata("/controlled/personal", true), qualifiedName: "enterprise:controlled" });
  assert.equal((await f.port.discoverSkills(request)).skills.length, 0);
});

test("unqualified collisions fail and an enterprise qualified name cannot resolve a personal item", async () => {
  const f = fixture();
  f.setCatalog({
    status: "ready",
    ownerKey: "c".repeat(64),
    allowFilesystem: true,
    personalSkills: true,
    dangerousSkills: true,
    assets: [{ ...reference, name: "Controlled", distributed: true }],
    experts: [],
    connectors: [],
  });
  f.personal({ ...metadata("/controlled/personal", true), name: "Controlled" });
  await assert.rejects(
    () => f.port.loadSkill({ ...request, name: "Controlled" }),
    /enterprise_skill_ambiguous/,
  );
  assert.equal((await f.port.loadSkill(request)).metadata.source, "remote");
});

test("an administrative display name cannot alias another reserved enterprise identity", async () => {
  const f = fixture();
  f.setCatalog({
    status: "ready",
    ownerKey: "c".repeat(64),
    allowFilesystem: true,
    personalSkills: false,
    dangerousSkills: false,
    assets: [{ ...reference, name: "enterprise:other", distributed: true }],
    experts: [],
    connectors: [],
  });
  await assert.rejects(
    () => f.port.loadSkill({ ...request, name: "enterprise:other" }),
    /enterprise_skill_not_found/,
  );
  assert.equal((await f.port.loadSkill(request)).metadata.qualifiedName, "enterprise:controlled");
});

test("foreign parsed paths and admission mutation cannot redirect a verified enterprise root", async () => {
  const f = fixture();
  f.foreign();
  await assert.rejects(() => f.port.discoverSkills(request), /enterprise_asset_scope_mismatch/);
  const healthy = fixture();
  healthy.mutate();
  assert.equal((await healthy.port.loadSkill(request)).baseDirectory, reference.directory);
});

test("parent-context cancellation prevents a late body while unmanaged and standalone paths retain original behavior", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.duringLoad(() => controller.abort());
  await assert.rejects(
    () =>
      f.port.loadSkill(request, {
        context: { trace: traceContext, logger: {} as never, abortSignal: controller.signal },
      }),
    /enterprise_authorization_cancelled/,
  );
  const unmanaged = fixture();
  unmanaged.setCatalog({ status: "unmanaged" });
  assert.equal((await unmanaged.port.loadSkill(request)).metadata.name, "Personal");
  assert.equal(unmanaged.admissions.length, 0);
  assert.equal(
    withEnterpriseSkillAuthorization(unmanaged.personalPort, {
      ...unmanaged.context,
      authorization: undefined,
      catalog: undefined,
    }),
    unmanaged.personalPort,
  );
});

test(
  "cancellation bounds an uncooperative SkillPort read without waiting for late body completion",
  { timeout: 1000 },
  async () => {
    const f = fixture(),
      controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const port = withEnterpriseSkillAuthorization(f.personalPort, {
      ...f.context,
      enterprisePort: {
        async discoverSkills() {
          started();
          return new Promise<never>(() => {});
        },
        async loadSkill() {
          throw new Error("Not reached");
        },
      },
    });
    const work = port.discoverSkills(request, { signal: controller.signal });
    await entered;
    controller.abort();
    await assert.rejects(() => work, /enterprise_authorization_cancelled/);
  },
);

test(
  "an unmanaged backing adapter also cannot retain a cancelled guarded operation",
  { timeout: 1000 },
  async () => {
    const f = fixture(),
      controller = new AbortController();
    f.setCatalog({ status: "unmanaged" });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.personalPort.loadSkill = async () => {
      entered();
      return new Promise<never>(() => {});
    };
    const work = f.port.loadSkill(request, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(() => work, /enterprise_authorization_cancelled/);
  },
);
