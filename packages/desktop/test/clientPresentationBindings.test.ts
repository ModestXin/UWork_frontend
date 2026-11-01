import assert from "node:assert/strict";
import { test } from "node:test";
import { createClientPresentationBindings } from "../src/main/clientPresentationBindings.js";
import { createHostClientPresentationBridge } from "../src/host/clientPresentationBridge.js";

const ready = (version = 1) => ({
  status: "ready" as const,
  help: {
    status: "ready" as const,
    version,
    data: {
      communityUrls: { "zh-CN": "https://help.example.test/", "en-US": null },
      feedback: { mode: "disabled" as const, url: null },
    },
  },
  desktop: {
    status: "ready" as const,
    version,
    data: {
      desktopContextPrompt: { enabled: true },
      rendererActionTrace: { enabled: true, sampleRatio: 0.2, enabledGroups: ["core" as const] },
    },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const requests: { sender: number; requestId: string }[] = [];
  const child = (sender: number) => ({
    postMessage: (message: { requestId: string }) =>
      requests.push({ sender, requestId: message.requestId }),
  });
  const first = child(1),
    second = child(2);
  const current = new Map([
    [1, first],
    [2, second],
  ]);
  const changed: number[] = [];
  const bindings = createClientPresentationBindings({
    currentChild: (senderId) => current.get(senderId),
    changed: (senderId) => changed.push(senderId),
  });
  const respond = (
    sender: number,
    source = current.get(sender)!,
    requestId = requests.at(-1)!.requestId,
    sourceEpoch = 0,
    projection = ready(),
  ) =>
    bindings.receive(sender, source, {
      type: "client-presentation-result",
      requestId,
      sourceEpoch,
      projection,
    });
  return { bindings, requests, current, changed, first, second, child, respond };
}

test("presentation reads belong to the exact current child and window", async () => {
  const f = fixture();
  const reading = f.bindings.read(1);
  const requestId = f.requests[0]!.requestId;
  f.respond(1, f.second, requestId);
  f.respond(2, f.second, requestId);
  assert.deepEqual(f.changed, []);
  f.respond(1, f.first, requestId);
  const result = await reading;
  assert.equal(result.projection.status, "ready");
  assert.equal(f.bindings.isCurrent(1, result.bindingEpoch), true);
  assert.equal(f.bindings.isCurrent(2, result.bindingEpoch), false);
  assert.deepEqual(f.changed, [1]);
  f.bindings.dispose();
});

test("identical successful reads keep the epoch while source or publication changes rotate it", async () => {
  const f = fixture();
  const first = f.bindings.read(1);
  f.respond(1);
  const a = await first;
  const same = f.bindings.read(1);
  f.respond(1);
  assert.equal((await same).bindingEpoch, a.bindingEpoch);
  const publication = f.bindings.read(1);
  f.respond(1, f.first, undefined, 0, ready(2));
  const b = await publication;
  assert.notEqual(b.bindingEpoch, a.bindingEpoch);
  const owner = f.bindings.read(1);
  f.respond(1, f.first, undefined, 1, ready(2));
  assert.notEqual((await owner).bindingEpoch, b.bindingEpoch);
  f.bindings.dispose();
});

test("invalidation settles old work and prevents the new owner from reusing its promise", async () => {
  const f = fixture();
  const old = f.bindings.read(1);
  assert.equal(f.bindings.read(1), old, "only the same in-flight source may coalesce");
  const oldId = f.requests[0]!.requestId;
  f.bindings.receive(1, f.first, { type: "client-presentation-invalidated", sourceEpoch: 1 });
  assert.equal((await old).projection.status, "unavailable");
  const fresh = f.bindings.read(1);
  assert.notEqual(fresh, old);
  assert.equal(f.requests.length, 2);
  f.respond(1, f.first, oldId, 0);
  f.respond(1, f.first, undefined, 1);
  const accepted = await fresh;
  f.respond(1, f.first, oldId, 0, ready(9));
  assert.equal(f.bindings.isCurrent(1, accepted.bindingEpoch), true);
  const waiting = f.bindings.read(1);
  f.current.set(1, f.child(1));
  f.bindings.forgetChild(f.first);
  assert.equal((await waiting).projection.status, "unavailable");
  assert.equal(f.bindings.isCurrent(1, accepted.bindingEpoch), false);
  f.bindings.dispose();
});

test("Host bridge invalidates before reading and never publishes a late identity projection", async () => {
  const pending = deferred<ReturnType<typeof ready>>();
  const messages: Array<{ type: string; requestId?: string; sourceEpoch: number }> = [];
  let changed!: () => void;
  let reads = 0,
    disposed = false;
  const bridge = createHostClientPresentationBridge({
    identity: {
      onDidChange: (listener: () => void) => {
        changed = listener;
        return () => {
          disposed = true;
        };
      },
      readClientPresentation: async () => (++reads === 1 ? pending.promise : ready(2)),
    },
    publish: (message) => messages.push(message),
  });
  const old = bridge.read("old");
  changed();
  assert.deepEqual(messages, [{ type: "client-presentation-invalidated", sourceEpoch: 1 }]);
  await bridge.read("new");
  pending.resolve(ready());
  await old;
  assert.deepEqual(
    messages.map((message) => message.requestId),
    [undefined, "new"],
  );
  assert.equal(reads, 2);
  bridge.dispose();
  assert.equal(disposed, true);
});

test("a replacement service within the same Host cannot reset its source epoch", async () => {
  let epoch = 0;
  const messages: Array<{ sourceEpoch: number }> = [];
  const options = {
    identity: { onDidChange: () => () => {}, readClientPresentation: async () => ready() },
    nextSourceEpoch: () => ++epoch,
    publish: (message: { sourceEpoch: number }) => messages.push(message),
  };
  const first = createHostClientPresentationBridge(options);
  await first.read("first");
  first.dispose();
  const replacement = createHostClientPresentationBridge(options);
  await replacement.read("replacement");
  assert.deepEqual(
    messages.map((message) => message.sourceEpoch),
    [1, 2, 3],
  );
  replacement.dispose();
});

test("Host initialization wakes a renderer whose first read preceded the child attachment", async () => {
  const f = fixture();
  f.current.delete(1);
  assert.equal((await f.bindings.read(1)).projection.status, "unavailable");
  f.current.set(1, f.first);
  f.bindings.receive(1, f.first, { type: "client-presentation-invalidated", sourceEpoch: 1 });
  assert.deepEqual(
    f.changed,
    [1],
    "the initial Host fact must not be discarded for lack of an older binding",
  );
  const reading = f.bindings.read(1);
  f.respond(1, f.first, undefined, 1);
  assert.equal((await reading).projection.status, "ready");
  f.bindings.dispose();
});
