import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";
import { createSettingsSyncService } from "../src/settings-sync/settingsSyncService.js";
import { createSkillsService } from "../src/skills/skillsService.js";
import { getUworkUserStorageRoot, setDataBaseDir } from "../src/paths.js";
import type { ISettingService } from "../src/setting/setting.js";

const settingService: ISettingService = {
  async get() {
    throw new Error("unrelated settings read");
  },
  async update() {},
  async updateDataBaseDir() {},
  async ensureDefaultProject() {
    throw new Error("unrelated project write");
  },
};

async function fixture(t: TestContext, storageOverride = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uwork-settings-sync-skills-")));
  const previousHome = process.env.HOME;
  const previousStorage = process.env.ZCODE_STORAGE_DIR;
  process.env.HOME = join(root, "home");
  if (storageOverride) process.env.ZCODE_STORAGE_DIR = join(root, "explicit-storage");
  else delete process.env.ZCODE_STORAGE_DIR;
  setDataBaseDir(join(root, "data"));
  t.after(async () => {
    setDataBaseDir(null);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
    else process.env.ZCODE_STORAGE_DIR = previousStorage;
    await rm(root, { recursive: true, force: true });
  });
  const home = process.env.HOME;
  const source = join(home, ".claude", "skills", "controlled-import");
  const workspacePath = join(root, "workspace");
  const body =
    "---\nname: controlled-import\ndescription: controlled import\n---\nprivate fixture body\n";
  await mkdir(source, { recursive: true });
  await mkdir(workspacePath);
  await writeFile(join(source, "SKILL.md"), body);
  let owner = new AbortController();
  let authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: owner.signal,
    session: {
      token: "synthetic-private",
      issuerOrigin: "https://backend.example.test",
      expiresAt: Date.now() + 60000,
      profile: { id: "member", tenantId: "tenant", displayName: "Controlled", provider: "wecom" },
    },
  };
  let personal = true,
    dangerous = true,
    filesystem = true,
    managed = true,
    requests = 0;
  let responseOverride: (() => Response) | undefined;
  const backendSession = createUWorkBackendSession({
    resolveConfig: async () => ({
      backend: managed ? "uwork" : "ucas",
      apiBaseUrl: "https://backend.example.test",
    }),
    readAuthority: () => authority,
    readPersistedSession: async () => ({
      revision: authority.revision,
      session: authority.session,
    }),
    fetchImpl: async (input) => {
      requests++;
      assert.equal(new URL(String(input)).pathname, "/api/client/authorize");
      if (responseOverride) return responseOverride();
      return Response.json({
        allowed: true,
        tenantId: "tenant",
        personal: { skills: personal },
        security: {
          allowFilesystem: filesystem,
          allowShell: false,
          allowNetwork: false,
          dangerousSkills: dangerous,
          allowedDomains: [],
        },
      });
    },
  });
  // 真实 service 的依赖对象先独立命名，RED 阶段允许当前实现尚未消费新的私有依赖。
  const dependencies = { settingService, backendSession };
  const service = createSettingsSyncService(dependencies);
  return {
    root,
    home,
    source,
    body,
    workspacePath,
    service,
    target: join(getUworkUserStorageRoot(), "skills", "controlled-import"),
    legacyTarget: join(home, ".zcode", "skills", "controlled-import"),
    requests: () => requests,
    respond: (response: () => Response) => {
      responseOverride = response;
    },
    deny: () => {
      personal = false;
    },
    denyDangerous: () => {
      dangerous = false;
    },
    denyFilesystem: () => {
      filesystem = false;
    },
    unmanaged: () => {
      managed = false;
    },
    replaceOwner: () => {
      owner.abort();
      owner = new AbortController();
      authority = {
        ...authority,
        generation: authority.generation + 1,
        revision: authority.revision + 1,
        signal: owner.signal,
        session: {
          ...authority.session!,
          token: "synthetic-next-owner",
          profile: { ...authority.session!.profile, id: "next-member" },
        },
      };
    },
    selection(importMode: "copy" | "symlink" = "copy") {
      return {
        agent: "claudeCode" as const,
        category: "skills" as const,
        sourceScope: "global" as const,
        targetScope: "global" as const,
        importMode,
        skillPaths: [source],
      };
    },
  };
}

function observeReads(t: TestContext, run: (path: string) => void | Promise<void>) {
  const original = fs.readFile;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    await run(String(args[0]));
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function observeMkdir(t: TestContext, run: (path: string) => void | Promise<void>) {
  const original = fs.mkdir;
  t.mock.method(fs, "mkdir", async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    await run(String(args[0]));
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

async function absent(path: string) {
  await assert.rejects(fs.lstat(path), { code: "ENOENT" });
}

test("managed skills detect cannot read source contents after current policy denies", async (t) => {
  for (const permission of ["personal", "dangerous", "filesystem"] as const) {
    await t.test(permission, async (t) => {
      const f = await fixture(t);
      let contentReads = 0;
      observeReads(t, (path) => {
        if (path.startsWith(f.source)) contentReads++;
      });
      if (permission === "personal") f.deny();
      else if (permission === "dangerous") f.denyDangerous();
      else f.denyFilesystem();
      await assert.rejects(
        f.service.detect({ categories: ["skills"], intent: "manualImport" }),
        /enterprise_(?:personal_skills|filesystem)_denied/,
      );
      assert.equal(contentReads, 0, "denied discovery must not open SKILL.md");
    });
  }
});

test("a discovery selection cannot authorize Copy or Symlink after personal skills revoke", async (t) => {
  for (const importMode of ["copy", "symlink"] as const) {
    await t.test(importMode, async (t) => {
      const f = await fixture(t);
      const discovery = await f.service.detect({ categories: ["skills"], intent: "manualImport" });
      assert.equal(discovery.agents[0]?.categories[0]?.importableCount, 1);
      f.deny();
      const outcome = await f.service
        .importSelected({ selections: [f.selection(importMode)] })
        .then(
          () => "unexpected-success",
          () => "rejected",
        );
      await absent(f.target);
      await absent(f.legacyTarget);
      assert.equal(outcome, "rejected");
    });
  }
});

test("an owner or policy change after an actual source read prevents subsequent skill writes", async (t) => {
  for (const mode of ["policy", "owner", "filesystem"] as const) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      let triggered = false;
      observeReads(t, async (path) => {
        if (triggered || path !== join(f.source, "SKILL.md")) return;
        triggered = true;
        await Promise.resolve();
        if (mode === "policy") f.deny();
        else if (mode === "owner") f.replaceOwner();
        else f.denyFilesystem();
      });
      const outcome = await f.service.importSelected({ selections: [f.selection()] }).then(
        () => "unexpected-success",
        () => "rejected",
      );
      assert.equal(triggered, true, "the test must pause a real source file read");
      await absent(f.target);
      await absent(f.legacyTarget);
      assert.equal(outcome, "rejected");
    });
  }
});

test("revocation while a target parent mkdir settles cannot dispatch a Copy or Symlink", async (t) => {
  for (const importMode of ["copy", "symlink"] as const) {
    await t.test(importMode, async (t) => {
      const f = await fixture(t);
      let triggered = false;
      observeMkdir(t, (path) => {
        if (triggered || ![dirname(f.target), dirname(f.legacyTarget)].includes(path)) return;
        triggered = true;
        f.deny();
      });
      const outcome = await f.service
        .importSelected({ selections: [f.selection(importMode)] })
        .then(
          () => "unexpected-success",
          () => "rejected",
        );
      assert.equal(triggered, true, "the test must pause a real parent directory mutation");
      await absent(f.target);
      await absent(f.legacyTarget);
      assert.equal(outcome, "rejected");
    });
  }
});

test("multiple skills selections cannot adopt an owner or managed mode changed by intervening work", async (t) => {
  for (const mode of ["owner", "unmanaged"] as const) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const secondSource = join(f.home, ".claude", "skills", "second-import");
      await mkdir(secondSource, { recursive: true });
      await writeFile(
        join(secondSource, "SKILL.md"),
        f.body.replaceAll("controlled-import", "second-import"),
      );
      const command = join(f.home, ".claude", "commands", "switch-owner.md");
      await mkdir(dirname(command), { recursive: true });
      await writeFile(command, "controlled command");
      let triggered = false;
      observeReads(t, (path) => {
        if (path !== command || triggered) return;
        triggered = true;
        if (mode === "owner") f.replaceOwner();
        else f.unmanaged();
      });
      const outcome = await f.service
        .importSelected({
          selections: [
            f.selection(),
            { agent: "claudeCode", category: "commands", importMode: "copy" },
            { ...f.selection(), skillPaths: [secondSource] },
          ],
        })
        .then(
          () => "unexpected-success",
          () => "rejected",
        );
      assert.equal(triggered, true);
      await absent(join(dirname(f.target), "second-import"));
      await absent(join(dirname(f.legacyTarget), "second-import"));
      assert.equal(outcome, "rejected");
    });
  }
});

test("allowed Copy imports are visible in the existing reader and leave legacy history unchanged", async (t) => {
  for (const storageOverride of [false, true]) {
    await t.test(storageOverride ? "explicit storage" : "data root", async (t) => {
      const f = await fixture(t, storageOverride);
      const legacySentinel = join(f.home, ".zcode", "skills", "legacy", "SKILL.md");
      await mkdir(join(legacySentinel, ".."), { recursive: true });
      await writeFile(legacySentinel, "legacy untouched");
      const result = await f.service.importSelected({ selections: [f.selection()] });
      assert.equal(result.successCount, 1);
      assert.equal(await readFile(join(f.target, "SKILL.md"), "utf8"), f.body);
      const listed = await createSkillsService({ isDesktopRuntime: true }).list({
        workspacePath: f.workspacePath,
      });
      assert.ok(listed.skills.some((skill) => skill.name === "controlled-import"));
      assert.equal(await readFile(legacySentinel, "utf8"), "legacy untouched");
      await absent(f.legacyTarget);
    });
  }
});

test("non-skills discovery retains its existing admission without skill policy HTTP", async (t) => {
  const f = await fixture(t);
  f.deny();
  const source = join(f.home, ".claude", "commands", "controlled.md");
  await mkdir(join(source, ".."), { recursive: true });
  await writeFile(source, "controlled command");
  const discovery = await f.service.detect({ categories: ["commands"], intent: "manualImport" });
  assert.equal(discovery.agents[0]?.categories[0]?.category, "commands");
  const result = await f.service.importSelected({
    selections: [{ agent: "claudeCode", category: "commands", importMode: "copy" }],
  });
  assert.equal(result.successCount, 1);
  assert.equal(f.requests(), 0);
});

test("unmanaged skill imports preserve existing operation without enterprise policy HTTP", async (t) => {
  const f = await fixture(t);
  f.unmanaged();
  f.deny();
  assert.equal(
    (await f.service.detect({ categories: ["skills"], intent: "manualImport" })).agents.length,
    1,
  );
  assert.equal((await f.service.importSelected({ selections: [f.selection()] })).successCount, 1);
  assert.equal(f.requests(), 0);
});

test("allowed Symlink imports use the canonical root and are immediately visible", async (t) => {
  const f = await fixture(t);
  const result = await f.service.importSelected({ selections: [f.selection("symlink")] });
  assert.equal(result.successCount, 1);
  assert.equal((await fs.lstat(f.target)).isSymbolicLink(), true);
  assert.equal(await realpath(f.target), f.source);
  const listing = await createSkillsService({ isDesktopRuntime: true }).list({
    workspacePath: f.workspacePath,
  });
  assert.ok(listing.skills.some((skill) => skill.name === "controlled-import"));
  await absent(f.legacyTarget);
});

test("managed copy preserves modes and source symlink semantics", async (t) => {
  await t.test("nested relative symlink and modes", async (t) => {
    const f = await fixture(t);
    const resource = join(f.source, "resources");
    await mkdir(resource);
    await writeFile(join(resource, "asset.txt"), "controlled asset");
    await fs.chmod(join(resource, "asset.txt"), 0o751);
    await fs.chmod(resource, 0o750);
    await fs.symlink("asset.txt", join(resource, "alias.txt"));
    assert.equal((await f.service.importSelected({ selections: [f.selection()] })).successCount, 1);
    const copiedResource = join(f.target, "resources");
    assert.equal((await fs.lstat(copiedResource)).mode & 0o777, 0o750);
    assert.equal((await fs.lstat(join(copiedResource, "asset.txt"))).mode & 0o777, 0o751);
    assert.equal((await fs.lstat(join(copiedResource, "alias.txt"))).isSymbolicLink(), true);
    assert.equal(await fs.readlink(join(copiedResource, "alias.txt")), join(resource, "asset.txt"));
  });
  await t.test("source root symlink is copied without dereference", async (t) => {
    const f = await fixture(t);
    const original = join(f.root, "original-skill");
    await fs.rename(f.source, original);
    await fs.symlink(relative(dirname(f.source), original), f.source);
    assert.equal((await f.service.importSelected({ selections: [f.selection()] })).successCount, 1);
    assert.equal((await fs.lstat(f.target)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(f.target), original);
    assert.equal(await readFile(join(f.target, "SKILL.md"), "utf8"), f.body);
  });
});

test("managed copy refuses existing target files, directories and dangling symlinks", async (t) => {
  for (const kind of ["file", "directory", "dangling symlink"] as const) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      await mkdir(dirname(f.target), { recursive: true });
      if (kind === "file") await writeFile(f.target, "existing target");
      else if (kind === "directory") {
        await mkdir(f.target);
        await writeFile(join(f.target, "sentinel"), "existing target");
      } else await fs.symlink(join(f.root, "missing"), f.target);
      const result = await f.service.importSelected({ selections: [f.selection()] });
      assert.equal(result.successCount, 0);
      assert.equal(result.skippedCount, 1);
      if (kind === "file") assert.equal(await readFile(f.target, "utf8"), "existing target");
      else if (kind === "directory")
        assert.equal(await readFile(join(f.target, "sentinel"), "utf8"), "existing target");
      else assert.equal(await fs.readlink(f.target), join(f.root, "missing"));
    });
  }
});

test("managed copy refuses a descendant target even through a target-parent alias", async (t) => {
  for (const alias of [false, true]) {
    await t.test(alias ? "symlink alias" : "direct descendant", async (t) => {
      const f = await fixture(t);
      if (alias) {
        const storageAlias = join(f.root, "storage-alias");
        await fs.symlink(f.source, storageAlias);
        process.env.ZCODE_STORAGE_DIR = storageAlias;
      } else process.env.ZCODE_STORAGE_DIR = join(f.source, "nested-storage");
      const target = join(getUworkUserStorageRoot(), "skills", "controlled-import");
      const result = await f.service.importSelected({ selections: [f.selection()] });
      assert.equal(result.successCount, 0);
      assert.equal(result.failedCount, 1);
      await absent(target);
      assert.equal(await readFile(join(f.source, "SKILL.md"), "utf8"), f.body);
    });
  }
});

test("a policy change after copied content is read prevents that file write without rollback", async (t) => {
  const f = await fixture(t);
  const payload = join(f.source, "payload.txt");
  await writeFile(payload, "private copied content");
  let triggered = false;
  observeReads(t, (path) => {
    if (path !== payload) return;
    triggered = true;
    f.deny();
  });
  await assert.rejects(
    f.service.importSelected({ selections: [f.selection()] }),
    /enterprise_personal_skills_denied/,
  );
  assert.equal(triggered, true, "the copier must finish a real payload read before revocation");
  await absent(join(f.target, "payload.txt"));
  assert.equal(await readFile(join(f.target, "SKILL.md"), "utf8"), f.body);
});

test("a rejected content read still rechecks policy before handling its filesystem error", async (t) => {
  const f = await fixture(t);
  observeReads(t, (path) => {
    if (path !== join(f.source, "SKILL.md")) return;
    f.deny();
    throw Object.assign(new Error("private rejected read"), { code: "EACCES" });
  });
  await assert.rejects(
    f.service.detect({ categories: ["skills"], intent: "manualImport" }),
    /enterprise_personal_skills_denied/,
  );
  await absent(f.target);
});

test("managed backend failures are sanitized and cannot read or write a skill", async (t) => {
  for (const mode of ["http", "malformed"] as const) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      f.respond(() =>
        mode === "http"
          ? new Response(`private ${f.source}`, { status: 503 })
          : Response.json({ allowed: true, private: f.source }),
      );
      let contentReads = 0;
      observeReads(t, (path) => {
        if (path.startsWith(f.source)) contentReads++;
      });
      for (const operation of [
        () => f.service.detect({ categories: ["skills"], intent: "manualImport" }),
        () => f.service.importSelected({ selections: [f.selection()] }),
      ]) {
        await assert.rejects(
          operation,
          (error: unknown) =>
            error instanceof Error && error.message === "enterprise_policy_unavailable",
        );
      }
      assert.equal(contentReads, 0);
      await absent(f.target);
      await absent(f.legacyTarget);
    });
  }
});

test("policy revoked during the last non-skill selection prevents a mixed success result", async (t) => {
  const f = await fixture(t);
  const command = join(f.home, ".claude", "commands", "last-command.md");
  await mkdir(dirname(command), { recursive: true });
  await writeFile(command, "last controlled command");
  observeReads(t, (path) => {
    if (path === command) f.deny();
  });
  await assert.rejects(
    f.service.importSelected({
      selections: [
        f.selection(),
        { agent: "claudeCode", category: "commands", importMode: "copy" },
      ],
    }),
    /enterprise_personal_skills_denied/,
  );
  assert.equal(await readFile(join(f.target, "SKILL.md"), "utf8"), f.body);
});
