import assert from "node:assert/strict";
import test from "node:test";
import { createZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(lateAck = false) {
  const acknowledgements = [deferred<unknown>(), deferred<unknown>()];
  const cleanups = [deferred<void>(), deferred<void>()];
  const calls: string[] = [];
  const event = () => () => ({
    dispose() {
      calls.push("listener-disposed");
    },
  });
  const ack = (id: string) => ({ ack: { subscriptionId: id, logEpoch: "owned-epoch" } });
  type Options = Parameters<typeof createZCodeTaskIndexSyncer>[0];
  const agentService = {
    onDynamicSessionsIndexFrame: event,
    onDynamicWorkspaceConfigFrame: event,
    async subscribeSessionsIndexV4() {
      calls.push("subscribe-index");
      return lateAck ? acknowledgements[0]!.promise : ack("index");
    },
    async subscribeWorkspaceConfigV4() {
      calls.push("subscribe-config");
      return lateAck ? acknowledgements[1]!.promise : ack("config");
    },
    async unsubscribeSessionsIndexV4() {
      calls.push("unsubscribe-index");
      await cleanups[0]!.promise;
    },
    async unsubscribeWorkspaceConfigV4() {
      calls.push("unsubscribe-config");
      await cleanups[1]!.promise;
    },
  } as unknown as Options["agentService"];
  const syncer = createZCodeTaskIndexSyncer({
    agentService,
    taskIndexRepo: {} as Options["taskIndexRepo"],
  });
  return {
    syncer,
    agentService,
    calls,
    cleanups,
    acknowledge: () => acknowledgements.forEach((a, i) => a.resolve(ack(i ? "config" : "index"))),
  };
}

for (const lateAck of [false, true]) {
  test(`shutdown awaits ${lateAck ? "late subscription ACK and" : "active"} asynchronous unsubscribe`, async () => {
    const f = fixture(lateAck);
    f.syncer.ensureWorkspaceSubscription({ workspacePath: "/owned-shutdown" });
    await tick();
    let complete = false;
    const closing = f.syncer.disposeAllAndWait().then(() => {
      complete = true;
    });
    const again = f.syncer.disposeAllAndWait();
    await tick();
    assert.equal(complete, false);
    if (lateAck) {
      assert.equal(f.calls.filter((c) => c.startsWith("unsubscribe")).length, 0);
      f.acknowledge();
      await tick();
    }
    assert.equal(f.calls.filter((c) => c.startsWith("unsubscribe")).length, 2);
    f.cleanups[0]!.resolve();
    await tick();
    assert.equal(complete, false);
    f.cleanups[1]!.resolve();
    await Promise.all([closing, again]);
    assert.equal(complete, true);
    f.syncer.ensureWorkspaceSubscription({ workspacePath: "/must-not-subscribe" });
    await tick();
    assert.equal(f.calls.filter((c) => c.startsWith("subscribe")).length, 2);
    assert.equal(f.calls.filter((c) => c === "listener-disposed").length, 2);
    await f.syncer.disposeAllAndWait();
    assert.equal(f.calls.filter((c) => c.startsWith("unsubscribe")).length, 2);
  });
}

{
  test("shared task shutdown waits for index cleanup before disposing Agent and repository", async () => {
    const f = fixture();
    f.syncer.ensureWorkspaceSubscription({ workspacePath: "/owned-shutdown" });
    await tick();
    const agentCleanup = deferred<void>();
    Object.assign(f.agentService, {
      async disposeAllAndWait() {
        f.calls.push("dispose-agent");
        await agentCleanup.promise;
      },
    });
    type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
    const adapter = createZCodeTaskServiceAdapter({
      zcodeAgentService: f.agentService,
      taskIndexSyncer: f.syncer,
      taskIndexRepo: {
        close() {
          f.calls.push("close-repo");
        },
      } as Options["taskIndexRepo"],
    });
    const first = adapter.disposeAllAndWait();
    const second = adapter.disposeAllAndWait();
    assert.equal(first, second);
    await tick();
    assert.ok(!f.calls.includes("dispose-agent"));
    f.cleanups.forEach((c) => c.resolve());
    await tick();
    assert.equal(f.calls.filter((c) => c === "dispose-agent").length, 1);
    assert.ok(!f.calls.includes("close-repo"));
    agentCleanup.resolve();
    await Promise.all([first, second]);
    assert.equal(f.calls.at(-1), "close-repo");
    await adapter.disposeAllAndWait();
    assert.equal(f.calls.filter((c) => c === "close-repo").length, 1);
  });
}
