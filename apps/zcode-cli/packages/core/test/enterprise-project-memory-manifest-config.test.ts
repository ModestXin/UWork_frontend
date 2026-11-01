import assert from "node:assert/strict";
import { test } from "node:test";
import { DESCRIPTION, manifestFixture } from "./enterprise-project-memory-manifest.fixture.js";

const leaked = (value: unknown) => JSON.stringify(value).includes(DESCRIPTION);

for (const change of ["memory-use-off", "storage-root", "workspace-identity"] as const)
  test(
    `actual manifest read await ${change} invalidates resolved root without changing runtime memoryRoot`,
    { timeout: 5000 },
    async (t) => {
      const f = await manifestFixture(t);
      f.state.holdRead = true;
      await f.turn();
      await f.entered.promise;
      assert.equal(f.requests.length, 1, "main completed before the real topic read barrier");
      assert.equal(f.state.topicReads, 1);
      const memory = f.internal.config.memory;
      assert.ok(memory);
      if (change === "memory-use-off") memory.use = false;
      if (change === "storage-root") memory.cliStorageRoot = f.otherOwnedCwd;
      if (change === "workspace-identity") memory.workspaceIdentity = "owned-other-workspace";
      assert.equal(
        f.internal.memoryRoot,
        f.memoryRoot,
        "cached field alone cannot prove eligibility",
      );
      f.release.resolve();
      await f.drain();
      const durable = await f.store.messages({ sessionID: f.id });
      assert.deepEqual(
        durable.map((message) => message.info.role),
        ["user", "assistant"],
      );
      assert.ok(!leaked(f.requests), "stale config must not release pending topic description");
      assert.equal(f.sidecars().length, 0);
      assert.equal(f.internal.memoryExtractionScheduler?.getCursor(), undefined);
    },
  );

for (const proof of ["missing-owner", "malformed-owner", "port-error"] as const)
  test(
    `initial manifest ${proof} skips scan while ordinary main text remains valid`,
    { timeout: 5000 },
    async (t) => {
      const f = await manifestFixture(t);
      f.setPort({
        async authorize(request, signal) {
          if (request.toolName !== "ProjectMemoryManifestRead")
            return f.authorization.authorize(request, signal);
          if (proof === "port-error") throw new Error("controlled manifest port unavailable");
          return {
            allowed: true,
            code: "allowed",
            ...(proof === "malformed-owner" ? { ownerKey: "invalid-owner-proof" } : {}),
          };
        },
      });
      await f.turn();
      await f.drain();
      assert.equal(f.requests.length >= 1, true, "ordinary main text must still complete");
      const durable = await f.store.messages({ sessionID: f.id });
      assert.deepEqual(
        durable.map((message) => message.info.role),
        ["user", "assistant"],
      );
      assert.deepEqual(
        { listings: f.state.listings, topicReads: f.state.topicReads, leaked: leaked(f.requests) },
        { listings: 0, topicReads: 0, leaked: false },
        "unproven manifest permission must fail before directory or topic I/O",
      );
      assert.equal(f.sidecars().length, 0);
      assert.equal(f.internal.memoryExtractionScheduler?.getCursor(), undefined);
    },
  );
