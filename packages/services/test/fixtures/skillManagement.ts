import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { createSkillsService } from "../../src/skills/skillsService.js";
import { createUWorkBackendSession } from "../../src/enterprise-identity/uworkBackendSession.js";
import type { EnterpriseIdentityAuthority } from "../../src/enterprise-identity/identityServiceLifecycle.js";
import { getUworkUserCliConfigPath, setDataBaseDir } from "../../src/paths.js";

export const originalFS = {
  readFile: fs.readFile,
  writeFile: fs.writeFile,
  lstat: fs.lstat,
  rm: fs.rm,
};
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function observe(
  t: TestContext,
  method: "readFile" | "writeFile" | "mkdir" | "rm" | "realpath" | "appendFile",
  callback: (args: unknown[]) => Promise<void> | void,
) {
  const original = fs[method] as (...args: unknown[]) => Promise<unknown>;
  t.mock.method(fs, method, async (...args: unknown[]) => {
    const value = await original(...args);
    await callback(args);
    return value;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

export function pauseAfter(
  t: TestContext,
  method: "readFile" | "writeFile" | "mkdir" | "rm" | "realpath" | "appendFile",
  matches: (args: unknown[]) => boolean,
) {
  const entered = deferred(),
    release = deferred();
  let hit = false;
  observe(t, method, async (args) => {
    const matched = matches(args);
    if (hit || !matched) return;
    hit = true;
    entered.resolve();
    await release.promise;
  });
  t.after(release.resolve);
  return {
    async entered() {
      await Promise.race([
        entered.promise,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("fixture pause not reached")), 5000);
          timer.unref();
        }),
      ]);
    },
    release: release.resolve,
  };
}

export async function exists(path: string) {
  return originalFS.lstat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

export async function outcome(operation: Promise<unknown>) {
  return operation.then(
    () => "success",
    (error: unknown) => (error instanceof Error ? error.message : "unknown error"),
  );
}

export async function fixture(t: TestContext, common = false, unmanaged = false) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "uwork-skill-management-")));
  const previousHome = process.env.HOME,
    previousStorage = process.env.ZCODE_STORAGE_DIR;
  process.env.HOME = join(root, "home");
  process.env.ZCODE_STORAGE_DIR = join(root, "storage");
  setDataBaseDir(join(root, "data"));
  const workspacePath = join(root, "workspace");
  const sourceDir = join(workspacePath, common ? ".zcode" : ".agents", "skills", "controlled");
  const source = join(sourceDir, "SKILL.md");
  const body = "---\nname: controlled\ndescription: owned fixture\n---\nowned fixture body\n";
  const configPath = getUworkUserCliConfigPath();
  const initialConfig = `${JSON.stringify({ plugins: { enabled: false }, sentinel: "preserve" })}\n`;
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(dirname(configPath), { recursive: true });
  await fs.writeFile(source, body);
  await fs.writeFile(configPath, initialConfig);
  let personal = true,
    dangerous = true,
    filesystem = true,
    requests = 0,
    revoked = false;
  let configHook: (() => Promise<void>) | undefined;
  let responseOverride: unknown;
  let responseStatus = 200;
  let policyResponse: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    if (request.url !== "/api/client/authorize" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    requests++;
    for await (const _chunk of request) {
      /* consume only the controlled authorization body */
    }
    response.writeHead(responseStatus, { "content-type": "application/json" }).end(
      JSON.stringify(
        responseOverride ?? {
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
        },
      ),
    );
    policyResponse?.();
    policyResponse = undefined;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  let controller = new AbortController();
  let authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: controller.signal,
    session: {
      token: "synthetic-private",
      issuerOrigin: origin,
      expiresAt: Date.now() + 60000,
      profile: { id: "member", tenantId: "tenant", displayName: "Controlled", provider: "wecom" },
    },
  };
  const backendSession = createUWorkBackendSession({
    resolveConfig: async () => {
      await configHook?.();
      return { backend: unmanaged ? "ucas" : "uwork", apiBaseUrl: origin };
    },
    readAuthority: () => authority,
    readPersistedSession: async () => ({
      revision: authority.revision,
      session: authority.session,
    }),
  });
  const service = createSkillsService({ isDesktopRuntime: true, backendSession });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setDataBaseDir(null);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
    else process.env.ZCODE_STORAGE_DIR = previousStorage;
    await originalFS.rm(root, { recursive: true, force: true });
  });
  const skill = (await service.list({ workspacePath })).skills.find((item) => item.path === source);
  assert(skill, "the guarded real service must discover the owned fixture");
  return {
    root,
    backendSession,
    workspacePath,
    sourceDir,
    source,
    body,
    configPath,
    initialConfig,
    service,
    skillId: skill.id,
    commonRoot: join(workspacePath, ".zcode", "skills"),
    target: join(workspacePath, ".zcode", "skills", "controlled", "SKILL.md"),
    requests: () => requests,
    revoked: () => revoked,
    allow() {
      personal = dangerous = filesystem = true;
      revoked = false;
    },
    respond(value: unknown, status = 200) {
      responseOverride = value;
      responseStatus = status;
    },
    configPause(value: (() => Promise<void>) | undefined) {
      configHook = value;
    },
    nextPolicy() {
      return new Promise<void>((resolve) => {
        policyResponse = resolve;
      });
    },
    logout() {
      controller.abort();
      authority = {
        ...authority,
        generation: authority.generation + 1,
        revision: authority.revision + 1,
        session: null,
      };
    },
    revoke(mode: "personal" | "dangerous" | "filesystem" | "owner") {
      revoked = true;
      if (mode === "personal") personal = false;
      else if (mode === "dangerous") dangerous = false;
      else if (mode === "filesystem") filesystem = false;
      else {
        controller.abort();
        controller = new AbortController();
        authority = {
          ...authority,
          generation: 2,
          revision: 2,
          signal: controller.signal,
          session: {
            ...authority.session!,
            token: "synthetic-next-owner",
            profile: { ...authority.session!.profile, id: "next-member" },
          },
        };
      }
    },
  };
}
