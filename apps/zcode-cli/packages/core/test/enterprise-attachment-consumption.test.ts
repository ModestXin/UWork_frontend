import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionStorePort } from "@zcode/contracts";
import { deferred, fixture, KINDS } from "./enterprise-attachment-runtime.fixture.js";

for (const kind of KINDS) {
  test(
    `actual ordinary Runtime positively consumes local ${kind}`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture(t),
        attachment = f.attachment(kind);
      await f.runtime.executeTurn("plain question", [attachment]);
      assert.equal(f.state.reads, 1);
      assert.ok(f.modelText().includes(f.marker(kind)));
      assert.equal(f.writes.length, kind === "file" ? 0 : 1);
    },
  );

  test(
    `actual ordinary Runtime denies local ${kind} before filesystem access`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture(t),
        attachment = f.attachment(kind);
      f.state.allowed = false;
      await f.runtime.executeTurn("plain question remains valid", [attachment]);
      assert.equal(f.state.reads, 0, "filesystem denial must precede the real attachment reader");
      assert.equal(f.state.stats, 0);
      assert.equal(f.writes.length, 0);
      assert.ok(!f.modelText().includes(f.marker(kind)));
      assert.ok(!f.history().includes(f.marker(kind)));
      assert.ok(f.modelText().includes("plain question remains valid"));
    },
  );

  for (const route of ["ordinary", "steering"] as const)
    test(
      `actual ${route} Runtime withholds ${kind} revoked while its reader waits`,
      { timeout: 5000 },
      async (t) => {
        const f = fixture(t),
          attachment = f.attachment(kind);
        f.controls.holdRead = true;
        if (route === "steering")
          f.controls.onModel = async (index) => {
            if (index === 0)
              assert.equal(
                (
                  await f.runtime.steerTurn({
                    input: "plain guide",
                    attachments: [attachment],
                    delivery: "guide",
                  })
                ).kind,
                "queued",
              );
          };
        const pending = f.runtime.executeTurn(
          "plain original",
          route === "ordinary" ? [attachment] : undefined,
        );
        await f.readEntered.promise;
        f.state.allowed = false;
        f.readRelease.resolve();
        await pending;
        assert.equal(f.state.reads, 1, "revocation occurs inside the actual filesystem await");
        assert.equal(f.writes.length, 0, "revoked media must not start a derived artifact write");
        assert.ok(
          !f.modelText().includes(f.marker(kind)),
          "new body must not reach a model request",
        );
        assert.ok(
          !f.history().includes(f.marker(kind)),
          "new body must not enter accepted history",
        );
      },
    );
}

for (const kind of ["file", "image"] as const)
  test(
    `defined empty inline ${kind} never reads a same-named local file`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture(t),
        local = f.attachment(kind);
      await f.runtime.executeTurn("plain inline question", [{ ...local, content: "" }]);
      assert.equal(f.state.stats, 0);
      assert.equal(f.state.reads, 0);
      assert.equal(f.writes.length, 0);
      assert.ok(!f.modelText().includes(f.marker(kind)));
    },
  );

test("the real Runtime sends only the fixed capability and original owner proof", async (t) => {
  const f = fixture(t),
    attachment = f.attachment("file");
  await f.runtime.executeTurn("plain question", [attachment]);
  assert.equal(f.admissions.length, 2);
  const [before, after] = f.admissions;
  assert.equal(before.toolName, "PromptAttachmentRead");
  assert.deepEqual(before.input, { path: attachment.path, kind: "file" });
  assert.deepEqual(before.capability, {
    permission: "filesystem",
    sideEffectScope: "none",
    readOnly: true,
    destructive: false,
  });
  assert.equal(before.phase, "before_dispatch");
  assert.equal(before.ownerKey, undefined);
  assert.equal(after.toolCallId, before.toolCallId);
  assert.equal(after.phase, "before_result");
  assert.equal(after.ownerKey, "a".repeat(64));
});

for (const change of [
  "owner",
  "managed",
  "unmanaged",
  "missing-owner",
  "port-removed",
  "port-replaced",
  "unavailable",
] as const)
  test(`pending attachment rejects ${change} without borrowing a new allow`, async (t) => {
    const f = fixture(t),
      attachment = f.attachment("file");
    if (change === "unmanaged") f.state.managed = false;
    f.controls.holdRead = true;
    const pending = f.runtime.executeTurn("plain question", [attachment]);
    await f.readEntered.promise;
    let replacementCalls = 0;
    if (change === "owner") f.state.ownerKey = "b".repeat(64);
    if (change === "managed") f.state.managed = false;
    if (change === "unmanaged") f.state.managed = true;
    if (change === "missing-owner") f.state.ownerKey = undefined;
    if (change === "port-removed") f.setPort(undefined);
    if (change === "port-replaced")
      f.setPort({
        async authorize() {
          replacementCalls++;
          return { allowed: true, code: "allowed", ownerKey: "b".repeat(64) };
        },
      });
    if (change === "unavailable") f.state.unavailable = true;
    f.readRelease.resolve();
    await pending;
    assert.equal(f.state.reads, 1);
    assert.equal(replacementCalls, 0);
    assert.ok(!f.modelText().includes(f.marker("file")));
    assert.ok(!f.history().includes(f.marker("file")));
  });

test("managed admission missing its owner proof never starts a local read", async (t) => {
  const f = fixture(t);
  f.state.ownerKey = undefined;
  await f.runtime.executeTurn("plain question", [f.attachment("file")]);
  assert.equal(f.state.reads, 0);
  assert.ok(!f.modelText().includes(f.marker("file")));
});

test("port replacement during the release authorization await cannot publish a late allow", async (t) => {
  const f = fixture(t);
  f.controls.holdAuthorizationPhase = "before_result";
  const pending = f.runtime.executeTurn("plain question", [f.attachment("file")]);
  await f.authorityEntered.promise;
  f.setPort({
    async authorize() {
      throw Error("replacement must never be used");
    },
  });
  f.authorityRelease.resolve();
  await pending;
  assert.equal(f.admissions.length, 2);
  assert.ok(!f.modelText().includes(f.marker("file")));
  assert.ok(!f.history().includes(f.marker("file")));
});

for (const unmanaged of ["standalone", "explicit"] as const)
  test(`${unmanaged} retains the original local attachment behavior`, async (t) => {
    const f = fixture(t);
    if (unmanaged === "standalone") f.setPort(undefined);
    else f.state.managed = false;
    await f.runtime.executeTurn("plain question", [f.attachment("file")]);
    assert.ok(f.modelText().includes(f.marker("file")));
    assert.equal(f.admissions.length, unmanaged === "standalone" ? 0 : 2);
    assert.ok(f.admissions.every((request) => request.ownerKey === undefined));
  });

test("a port introduced while an unmanaged local read waits cannot adopt its body", async (t) => {
  const f = fixture(t);
  f.setPort(undefined);
  f.controls.holdRead = true;
  const pending = f.runtime.executeTurn("plain question", [f.attachment("file")]);
  await f.readEntered.promise;
  f.setPort(f.authorization);
  f.readRelease.resolve();
  await pending;
  assert.equal(f.admissions.length, 0);
  assert.ok(!f.modelText().includes(f.marker("file")));
});

test("revocation during actual image processing precedes derived artifact publication", async (t) => {
  const f = fixture(t);
  f.controls.holdImage = true;
  const pending = f.runtime.executeTurn("plain question", [f.attachment("image")]);
  await f.imageEntered.promise;
  f.state.allowed = false;
  f.imageRelease.resolve();
  await pending;
  assert.equal(f.state.reads, 1);
  assert.equal(f.writes.length, 0);
  assert.ok(!f.modelText().includes(f.marker("image")));
});

test("withheld new B leaves previously accepted A in real request/history", async (t) => {
  const f = fixture(t);
  await f.runtime.executeTurn("accept A", [f.attachment("file", "A")]);
  f.state.allowed = false;
  await f.runtime.executeTurn("plain new question", [f.attachment("file")]);
  assert.equal(f.state.reads, 1, "B must not erase or reread accepted A");
  const latest = JSON.stringify(f.requests.at(-1));
  assert.ok(latest.includes(f.marker("file", "A")));
  assert.ok(f.history().includes(f.marker("file", "A")));
  assert.ok(!latest.includes(f.marker("file")));
  assert.ok(!f.history().includes(f.marker("file")));
});

test("new bodies in one attachment batch cannot enter history after a later read waits through revocation", async (t) => {
  const f = fixture(t),
    first = f.attachment("file", "A"),
    second = f.attachment("file");
  f.controls.holdRead = true;
  f.controls.holdReadPath = second.path;
  const pending = f.runtime.executeTurn("plain question", [first, second]);
  await f.readBlocked.promise;
  assert.equal(f.state.reads, 2, "the first body resolved before the second read blocked");
  f.state.allowed = false;
  f.readRelease.resolve();
  await pending;
  for (const label of ["A", "B"]) {
    assert.ok(!f.modelText().includes(f.marker("file", label)));
    assert.ok(!f.history().includes(f.marker("file", label)));
  }
});

test(
  "ordinary Runtime rechecks attachments after real shared-context storage waited",
  { timeout: 5000 },
  async (t) => {
    const entered = deferred(),
      release = deferred(),
      persisted: unknown[] = [];
    t.after(() => release.resolve());
    const sessionStore = {
      async createSession() {
        return {};
      },
      async getSession() {
        return null;
      },
      async updateSession() {
        return {};
      },
      async saveSessionEntry() {},
      async saveMessage(value: unknown) {
        persisted.push(value);
      },
      async savePart(value: unknown) {
        persisted.push(value);
      },
      async messages() {
        entered.resolve();
        await release.promise;
        return [
          {
            info: {
              role: "user",
              source: "shared_context",
              metadata: { contextId: "controlled-shared-context" },
            },
            parts: [{ type: "text", text: "controlled shared context" }],
          },
        ];
      },
    } as unknown as SessionStorePort;
    const f = fixture(t, { sessionStore });
    const pending = f.runtime.executeTurn("plain question", [f.attachment("file")], {
      sharedContextRefs: [
        { kind: "shared_context_import", context_id: "controlled-shared-context" },
      ],
    });
    await entered.promise;
    f.state.allowed = false;
    release.resolve();
    await pending;
    assert.ok(!f.modelText().includes(f.marker("file")));
    assert.ok(!f.history().includes(f.marker("file")));
    assert.ok(!JSON.stringify(persisted).includes(f.marker("file")));
  },
);

for (const route of ["ordinary", "steering"] as const)
  test(
    `actual ${route} cancellation retires a noncooperating FS read and its late body`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture(t),
        controller = new AbortController();
      f.controls.holdRead = true;
      const attachment = f.attachment("image");
      if (route === "steering")
        f.controls.onModel = async (index) => {
          if (index === 0)
            await f.runtime.steerTurn({
              input: "plain guide",
              attachments: [attachment],
              delivery: "guide",
            });
        };
      const pending = f.runtime.executeTurn(
        "plain original",
        route === "ordinary" ? [attachment] : undefined,
        { abortSignal: controller.signal },
      );
      const rejected = assert.rejects(pending);
      await f.readEntered.promise;
      controller.abort();
      await rejected;
      const calls = f.requests.length;
      f.readRelease.resolve();
      await f.readReturned.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.requests.length, calls);
      assert.equal(f.writes.length, 0);
      assert.equal(f.state.imageCalls, 0, "a late cancelled read must not start image processing");
      assert.ok(!f.history().includes(f.marker("image")));
    },
  );

for (const phase of ["before_dispatch", "before_result"] as const)
  test(
    `cancellation retires noncooperating ${phase} authorization and ignores its late allow`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture(t),
        controller = new AbortController();
      f.controls.holdAuthorizationPhase = phase;
      const pending = f.runtime.executeTurn("plain question", [f.attachment("file")], {
        abortSignal: controller.signal,
      });
      const rejected = assert.rejects(pending);
      await f.authorityEntered.promise;
      controller.abort();
      await rejected;
      f.authorityRelease.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.state.reads, phase === "before_dispatch" ? 0 : 1);
      assert.equal(f.requests.length, 0);
      assert.ok(!f.history().includes(f.marker("file")));
    },
  );
