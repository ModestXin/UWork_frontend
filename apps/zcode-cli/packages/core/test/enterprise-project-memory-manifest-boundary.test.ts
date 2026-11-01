import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { test } from "node:test";
import { createSessionId } from "@zcode/contracts";
import { DESCRIPTION, manifestFixture } from "./enterprise-project-memory-manifest.fixture.js";

const TEST_TIMEOUT_MS = 5_000;
const ABORT_DRAIN_LIMIT_MS = 100;
const leaked = (value: unknown) => JSON.stringify(value).includes(DESCRIPTION);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assertWithheld(f: Awaited<ReturnType<typeof manifestFixture>>) {
  assert.ok(f.requests.length >= 1, "ordinary main text must still complete");
  assert.ok(!leaked(f.requests), "unreleased description must not reach any model request");
  assert.equal(f.sidecars().length, 0);
  assert.equal(f.internal.memoryExtractionScheduler?.getCursor(), undefined);
}

for (const change of [
  "config",
  "filesystem",
  "port",
  "session",
  "workspace",
  "memory-root",
  "shutdown",
] as const)
  test(
    `final manifest owner proof microtask ${change} withholds bytes before synchronous consumption`,
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const f = await manifestFixture(t);
      let queued = false;
      let applied = false;
      f.setPort({
        async authorize(request, signal) {
          const decision = await f.authorization.authorize(request, signal);
          if (request.toolName !== "ProjectMemoryManifestRead" || request.phase !== "before_result")
            return decision;
          return {
            ...decision,
            get ownerKey() {
              // 在最后一次证明被消费时排入微任务，覆盖读取完成后的 async 返回边界。
              if (!queued) {
                queued = true;
                queueMicrotask(() => {
                  if (change === "config") {
                    assert.ok(f.internal.config.memory);
                    f.internal.config.memory.use = false;
                  }
                  if (change === "filesystem") f.internal.fileSystemPort = f.newFileSystem();
                  if (change === "port")
                    f.setPort({ authorize: f.authorization.authorize.bind(f.authorization) });
                  if (change === "session")
                    Object.defineProperty(f.runtime, "sessionId", {
                      configurable: true,
                      value: createSessionId("replacement-at-manifest-release"),
                    });
                  if (change === "workspace") f.internal.workspaceRoot = f.otherOwnedCwd;
                  if (change === "memory-root") f.internal.memoryRoot = f.otherOwnedCwd;
                  if (change === "shutdown") f.runtime.beginShutdown();
                  applied = true;
                });
              }
              return decision.ownerKey;
            },
          };
        },
      });

      await f.turn();
      await f.drain();

      assert.ok(applied, "the mutation must execute after the actual release proof is read");
      assert.equal(f.state.topicReads, 1, "the real owned topic read completed before release");
      assertWithheld(f);
      assert.deepEqual(
        f.admissions
          .filter((request) => request.toolName === "ProjectMemoryManifestRead")
          .map((request) => request.phase),
        ["before_dispatch", "before_result"],
      );
    },
  );

test(
  "allowed empty manifest preserves the original natural extraction and successful cursor",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const f = await manifestFixture(t);
    await unlink(f.topic);

    await f.turn();
    await f.drain();

    assert.equal(f.state.listings, 1);
    assert.equal(f.state.topicReads, 0);
    assert.equal(f.sidecars().length, 1);
    assert.ok(!leaked(f.requests));
    const durable = await f.store.messages({ sessionID: f.id });
    assert.deepEqual(
      durable.map((message) => message.info.role),
      ["user", "assistant"],
    );
    assert.equal(f.internal.memoryExtractionScheduler?.getCursor(), durable.at(-1)?.info.id);
  },
);

for (const phase of ["before_dispatch", "before_result"] as const)
  test(
    `original scheduler shutdown races uncooperative manifest authorization ${phase}`,
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const entered = deferred();
      const release = deferred();
      t.after(release.resolve);
      const f = await manifestFixture(t);
      f.setPort({
        async authorize(request, signal) {
          const decision = await f.authorization.authorize(request, signal);
          if (request.toolName === "ProjectMemoryManifestRead" && request.phase === phase) {
            entered.resolve();
            await release.promise;
          }
          return decision;
        },
      });

      await f.turn();
      await entered.promise;
      f.runtime.beginShutdown();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settledBeforeRelease: boolean;
      try {
        settledBeforeRelease = await Promise.race([
          f.drain().then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), ABORT_DRAIN_LIMIT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        release.resolve();
      }
      await f.drain();

      assert.ok(
        settledBeforeRelease,
        "drain must settle without the uncooperative permission result",
      );
      assert.equal(f.state.topicReads, phase === "before_dispatch" ? 0 : 1);
      assertWithheld(f);
    },
  );
