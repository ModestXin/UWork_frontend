import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  readdir,
  rm,
  mkdir,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createEnterpriseAssetStore } from "../src/enterprise-assets/assetStore.js";

async function setup(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "uwork-enterprise-assets-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const personal = join(home, "personal");
  await mkdir(personal);
  await writeFile(join(personal, "SKILL.md"), "personal untouched");
  return {
    root: join(home, "cache"),
    home,
    personal,
    store: createEnterpriseAssetStore({ root: join(home, "cache") }),
  };
}
function bundle(version = 1, text = "Controlled instructions") {
  const content = {
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: controlled\ndescription: Controlled test\n---\n${text}`,
      },
      { path: "references/info.txt", content: "controlled data" },
    ],
    highRisk: false,
  };
  return {
    id: "controlled-asset",
    kind: "skill" as const,
    version,
    content,
    checksum: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}
const current = { traceId: "controlled-assets-trace", isCurrent: () => true };

test("enterprise assets materialize immutable versions, verify reuse and prune only owned content", async (t) => {
  const f = await setup(t);
  const first = await f.store.materialize(bundle(), current);
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.match(
    await readFile(join(first.directory, "SKILL.md"), "utf8"),
    /Controlled instructions/,
  );
  assert.equal((await f.store.materialize(bundle(), current)).directory, first.directory);
  const second = await f.store.materialize(bundle(2, "Version two"), current);
  assert.notEqual(second.directory, first.directory);
  assert.match(
    await readFile(join(first.directory, "SKILL.md"), "utf8"),
    /Controlled instructions/,
  );
  assert.match(await readFile(join(second.directory, "SKILL.md"), "utf8"), /Version two/);
  await f.store.prune([second.key], current);
  await assert.rejects(() => f.store.verify(first.key, current));
  assert.equal((await f.store.verify(second.key, current)).key, second.key);
  assert.equal(await readFile(join(f.personal, "SKILL.md"), "utf8"), "personal untouched");
});

test("bad package checksums and portable path aliases fail before publication", async (t) => {
  const f = await setup(t);
  await assert.rejects(() =>
    f.store.materialize({ ...bundle(), checksum: "0".repeat(64) }, current),
  );
  for (const paths of [
    ["../outside"],
    ["CON .txt"],
    ["notes\u0085.txt"],
    ["\ud800.txt"],
    ["s.txt", "\u017f.txt"],
    ["\u03c3", "\u03c2/file"],
    ["file", "file/child"],
  ]) {
    const value = bundle();
    value.content.files.push(...paths.map((path) => ({ path, content: "unsafe" })));
    value.checksum = createHash("sha256").update(JSON.stringify(value.content)).digest("hex");
    await assert.rejects(() => f.store.materialize(value, current));
  }
  assert.equal((await readdir(f.home)).includes("outside"), false);
});

test("tampering, unexpected files and symlinks cannot become verified enterprise assets or be pruned", async (t) => {
  const f = await setup(t);
  const first = await f.store.materialize(bundle(), current);
  await writeFile(join(first.directory, "SKILL.md"), "tampered");
  await assert.rejects(() => f.store.verify(first.key, current));
  await assert.rejects(() => f.store.prune([], current));
  assert.equal(await readFile(join(first.directory, "SKILL.md"), "utf8"), "tampered");
  const second = await f.store.materialize(bundle(2), current);
  await symlink(f.personal, join(second.directory, "escape"), "dir");
  await assert.rejects(() => f.store.verify(second.key, current));
  assert.equal(await readFile(join(f.personal, "SKILL.md"), "utf8"), "personal untouched");
});

test("hardlinked files and unmarked roots are rejected without adopting personal data", async (t) => {
  const f = await setup(t);
  const unsafe = createEnterpriseAssetStore({ root: f.personal });
  await assert.rejects(() => unsafe.materialize(bundle(), current));
  const object = await f.store.materialize(bundle(), current);
  await rm(join(object.directory, "SKILL.md"));
  await link(join(f.personal, "SKILL.md"), join(object.directory, "SKILL.md"));
  await assert.rejects(() => f.store.verify(object.key, current));
  await assert.rejects(() => f.store.prune([], current));
  assert.equal(await readFile(join(f.personal, "SKILL.md"), "utf8"), "personal untouched");
});

test("cancelled or obsolete installation cannot publish a reference", async (t) => {
  const f = await setup(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => f.store.materialize(bundle(), { ...current, signal: abort.signal }));
  await assert.rejects(() => f.store.materialize(bundle(), { ...current, isCurrent: () => false }));
  const installed = await f.store.materialize(bundle(), current);
  await assert.rejects(() => f.store.verify(installed.key, { ...current, isCurrent: () => false }));
  await assert.rejects(() => f.store.prune([], { ...current, isCurrent: () => false }));
  assert.equal((await f.store.verify(installed.key, current)).key, installed.key);
});

test("two stores serialize updates and never overwrite an existing immutable object", async (t) => {
  const f = await setup(t);
  await f.store.materialize(bundle(), current);
  const peer = createEnterpriseAssetStore({ root: f.root });
  const objects = await Promise.all([
    f.store.materialize(bundle(2), current),
    peer.materialize(bundle(2), current),
  ]);
  assert.equal(objects[0]!.key, objects[1]!.key);
  assert.equal((await peer.verify(objects[0]!.key, current)).key, objects[0]!.key);
  assert.equal(
    (await readdir(f.root)).some((name) => name.startsWith("stage-")),
    false,
  );
});

test("two fresh stores serialize bootstrap without adopting an existing unmarked root", async (t) => {
  const f = await setup(t);
  const peer = createEnterpriseAssetStore({ root: f.root });
  const objects = await Promise.all([
    f.store.materialize(bundle(), current),
    peer.materialize(bundle(), current),
  ]);
  assert.equal(objects[0]!.key, objects[1]!.key);
});

test("hash-shaped root symlinks, ordinary files and corrupt metadata fail closed", async (t) => {
  const f = await setup(t);
  const installed = await f.store.materialize(bundle(), current);
  const unexpected = join(f.root, "0".repeat(64));
  await symlink(f.personal, unexpected, "dir");
  await assert.rejects(() => f.store.verify(installed.key, current));
  await assert.rejects(() => f.store.materialize(bundle(2), current));
  await rm(unexpected);
  await writeFile(unexpected, "unknown bytes");
  await assert.rejects(() => f.store.verify(installed.key, current));
  await rm(unexpected);
  await writeFile(join(f.root, installed.key, "manifest.json"), "corrupt metadata");
  await assert.rejects(() => f.store.materialize(bundle(2), current));
  assert.equal(await readFile(join(f.personal, "SKILL.md"), "utf8"), "personal untouched");
});

test("owner invalidation after staging removes only the unpublished operation", async (t) => {
  const f = await setup(t);
  let fences = 0;
  await assert.rejects(
    () => f.store.materialize(bundle(), { ...current, isCurrent: () => ++fences < 6 }),
    /enterprise_asset_owner_changed/,
  );
  assert.equal(fences, 6);
  assert.equal(
    (await readdir(f.root)).some(
      (name) => /^[a-f0-9]{64}$/.test(name) || name.startsWith("stage-"),
    ),
    false,
  );
  assert.equal(await readFile(join(f.personal, "SKILL.md"), "utf8"), "personal untouched");
});

test("verified abandoned staging is cleaned but unknown staging and root symlinks are preserved and rejected", async (t) => {
  const f = await setup(t);
  await f.store.materialize(bundle(), current);
  const staged = join(f.root, "stage-00000000-0000-4000-8000-000000000000");
  await mkdir(staged);
  await writeFile(join(staged, ".ownership.json"), await readFile(join(f.root, ".owner.json")));
  await writeFile(join(staged, "partial.txt"), "incomplete derived bytes");
  await f.store.materialize(bundle(2), current);
  assert.equal((await readdir(f.root)).includes(staged.split(/[\\/]/).at(-1)!), false);
  const unknown = join(f.root, "stage-10000000-0000-4000-8000-000000000000");
  await mkdir(unknown);
  await writeFile(join(unknown, "personal.txt"), "unowned content");
  await assert.rejects(() => f.store.prune([], current));
  assert.equal(await readFile(join(unknown, "personal.txt"), "utf8"), "unowned content");
  const alias = join(f.home, "alias");
  await symlink(f.personal, alias, "dir");
  await assert.rejects(() =>
    createEnterpriseAssetStore({ root: alias }).materialize(bundle(), current),
  );
  assert.equal(await readFile(join(f.personal, "SKILL.md"), "utf8"), "personal untouched");
});

test("all textual asset kinds retain exact approved content and unsupported connectors never materialize", async (t) => {
  const f = await setup(t);
  const values = [
    {
      kind: "expert",
      content: { instructions: "Controlled expert", profession: "Review" },
      file: "expert.json",
    },
    { kind: "playbook", content: { markdown: "# Controlled playbook" }, file: "PLAYBOOK.md" },
    {
      kind: "instruction",
      content: { instructions: "Controlled instruction" },
      file: "INSTRUCTIONS.md",
    },
  ];
  for (const value of values) {
    const reference = await f.store.materialize(
      {
        id: `controlled-${value.kind}`,
        version: 1,
        kind: value.kind,
        content: value.content,
        checksum: createHash("sha256").update(JSON.stringify(value.content)).digest("hex"),
      },
      current,
    );
    assert.equal(reference.asset.kind, value.kind);
    const content = await readFile(join(reference.directory, value.file), "utf8");
    assert.equal(
      content,
      value.kind === "expert"
        ? JSON.stringify(value.content)
        : (value.content.markdown ?? value.content.instructions),
    );
  }
  await assert.rejects(() => f.store.materialize({ ...bundle(), kind: "connector" }, current));
});

test("a substituted cache lock cannot reclaim files outside the enterprise namespace", async (t) => {
  const f = await setup(t);
  await f.store.materialize(bundle(), current);
  await writeFile(join(f.personal, "owner-fixture.json"), JSON.stringify({ createdAt: 1 }));
  const lock = join(
    f.home,
    `.enterprise-assets-${createHash("sha256").update(f.root).digest("hex")}.lock`,
  );
  await symlink(f.personal, lock, "dir");
  await assert.rejects(() => f.store.materialize(bundle(2), current));
  assert.equal(await readFile(join(f.personal, "SKILL.md"), "utf8"), "personal untouched");
  assert.equal(
    await readFile(join(f.personal, "owner-fixture.json"), "utf8"),
    JSON.stringify({ createdAt: 1 }),
  );
});

test("staggered normal lock release does not make healthy cache verification fail", async (t) => {
  const f = await setup(t);
  const reference = await f.store.materialize(bundle(), current);
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: 8 }, async (_, worker) => {
      const peer = createEnterpriseAssetStore({ root: f.root });
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay((attempt + worker) % 4);
        try {
          await peer.verify(reference.key, current);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : "unexpected");
        }
      }
    }),
  );
  assert.deepEqual(failures, []);
});

test("cache outcomes and safe errors retain trace correlation without content or ownership tokens", async (t) => {
  const f = await setup(t);
  const events: unknown[] = [];
  const observed = createEnterpriseAssetStore({
    root: f.root,
    onEvent: (event) => events.push(event),
  });
  const reference = await observed.materialize(bundle(), current);
  await assert.rejects(
    () => observed.materialize({ ...bundle(), checksum: "0".repeat(64) }, current),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "traceId" in error &&
      error.traceId === current.traceId,
  );
  assert.equal(events.length, 2);
  assert.ok(JSON.stringify(events).includes(current.traceId));
  assert.ok(!JSON.stringify(events).includes("Controlled instructions"));
  assert.ok(!JSON.stringify(events).includes(reference.key));
});

test("unsafe trace IDs fail before IO and a failing observer cannot repeat or reject a cache commit", async (t) => {
  const f = await setup(t);
  let callbacks = 0;
  const observed = createEnterpriseAssetStore({
    root: f.root,
    onEvent: () => {
      callbacks++;
      throw new Error("controlled observer fault");
    },
  });
  await assert.rejects(
    () => observed.materialize(bundle(), { ...current, traceId: "bad\ntrace" }),
    /enterprise_asset_trace_required/,
  );
  assert.equal((await readdir(f.home)).includes("cache"), false);
  const reference = await observed.materialize(bundle(), current);
  assert.equal(callbacks, 1);
  assert.equal((await f.store.verify(reference.key, current)).key, reference.key);
  assert.equal((await readdir(f.root)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length, 1);
});

test(
  "a real pre-publication SIGKILL leaves no partial object and recovery reclaims only the owned stage",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await setup(t);
    const first = await f.store.materialize(bundle(), current);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/enterpriseAssetStageChild.mjs", import.meta.url)),
        f.root,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: f.home, NODE_ENV: "test" },
      },
    );
    let stderr = "",
      ready = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 2048);
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Controlled child did not stage: ${stderr}`)),
          5000,
        );
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (chunk.includes("controlled-stage-ready")) {
            ready = true;
            clearTimeout(timeout);
            resolve();
          }
        });
        void closed.then(() => {
          if (!ready) {
            clearTimeout(timeout);
            reject(new Error(`Controlled child closed before staging: ${stderr}`));
          }
        });
      });
      assert.equal((await readdir(f.root)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length, 1);
      assert.equal((await readdir(f.root)).filter((name) => name.startsWith("stage-")).length, 1);
      assert.equal(child.kill("SIGKILL"), true);
      assert.equal((await closed).signal, "SIGKILL");
      const recovered = await createEnterpriseAssetStore({ root: f.root }).materialize(
        bundle(3),
        current,
      );
      assert.equal(
        (await readdir(f.root)).some((name) => name.startsWith("stage-")),
        false,
      );
      assert.equal((await f.store.verify(first.key, current)).key, first.key);
      assert.equal((await f.store.verify(recovered.key, current)).key, recovered.key);
      assert.equal(await readFile(join(f.personal, "SKILL.md"), "utf8"), "personal untouched");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  },
);
