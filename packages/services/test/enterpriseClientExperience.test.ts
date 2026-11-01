import assert from "node:assert/strict";
import { test } from "node:test";
import { createClientPresentationReader } from "../src/enterprise-identity/clientPresentation.js";
import type {
  UWorkBackendScope,
  UWorkBackendSession,
} from "../src/enterprise-identity/backendSessionContract.js";

const configurations = () => ({
  "new-chat": { welcome: "Welcome", riskNotice: "Verify" },
  scenes: { draftSuggestions: [], scheduledTemplates: [], offPeakTemplates: [] },
  help: {
    communityUrls: { "zh-CN": null, "en-US": null },
    feedback: { mode: "disabled", url: null },
  },
  desktop: {
    desktopContextPrompt: { enabled: false },
    rendererActionTrace: { enabled: false, sampleRatio: 0, enabledGroups: [] },
  },
  "plugin-store": { order: null },
});

function fixture() {
  let data: Record<string, unknown> = configurations();
  let versions: Record<string, unknown> = Object.fromEntries(
    Object.keys(data).map((key) => [key, 0]),
  );
  let validOwner = true;
  let status = 200;
  const paths: string[] = [];
  const backend: UWorkBackendSession = {
    async run(operation) {
      const scope: UWorkBackendScope = {
        ownerKey: "synthetic-owner",
        origin: "https://owned.example.test",
        tenantId: "tenant",
        memberId: "member",
        signal: new AbortController().signal,
        isCurrent: () => validOwner,
        async assertCurrent() {
          if (!validOwner) throw Error("owner changed");
        },
        async request(path) {
          paths.push(path);
          return {
            status,
            body: { tenantId: "tenant", versions, configuration: data, riskPrefix: "AI generated" },
          };
        },
      };
      return { managed: true, value: await operation(scope) };
    },
  };
  return {
    read: createClientPresentationReader(backend),
    paths,
    setData(value: Record<string, unknown>) {
      data = value;
    },
    setVersions(value: Record<string, unknown>) {
      versions = value;
    },
    invalidate() {
      validOwner = false;
    },
    failHttp() {
      status = 503;
    },
  };
}

test("new backend defaults are ready publications for every kind, including version zero and empty arrays", async () => {
  const f = fixture();
  const view = (await f.read()) as unknown as Record<string, unknown>;
  assert.equal(view.status, "ready");
  for (const [field, kind] of [
    ["scenes", "scenes"],
    ["help", "help"],
    ["desktop", "desktop"],
    ["pluginStore", "plugin-store"],
  ])
    assert.deepEqual(view[field!], {
      status: "ready",
      version: 0,
      data: configurations()[kind as keyof ReturnType<typeof configurations>],
    });
  assert.deepEqual(f.paths, ["/api/client/configuration"]);
});

test("older backends keep welcome and explicitly report unsupported kinds instead of successful empty data", async () => {
  const f = fixture();
  f.setData({ "new-chat": configurations()["new-chat"] });
  f.setVersions({ "new-chat": 2 });
  const view = (await f.read()) as unknown as Record<string, unknown>;
  assert.equal(view.welcome, "Welcome");
  for (const field of ["scenes", "help", "desktop", "pluginStore"])
    assert.deepEqual(view[field], { status: "unsupported" });
});

test("present malformed kinds are unavailable independently and do not discard other valid publications", async () => {
  const f = fixture();
  f.setData({
    ...configurations(),
    desktop: { desktopContextPrompt: { enabled: true }, secret: "reject" },
  });
  const view = (await f.read()) as unknown as Record<string, unknown>;
  assert.equal(view.welcome, "Welcome");
  assert.deepEqual(view.desktop, { status: "unavailable" });
  assert.deepEqual(view.help, { status: "ready", version: 0, data: configurations().help });
});

test("HTTP failure and invalidated private ownership cannot release a previous successful projection", async () => {
  const f = fixture();
  assert.equal((await f.read()).status, "ready");
  f.failHttp();
  assert.deepEqual(await f.read(), { status: "unavailable" });
  const stale = fixture();
  stale.invalidate();
  assert.deepEqual(await stale.read(), { status: "unavailable" });
});

test("a malformed Help URL invalidates that kind without throwing or discarding welcome", async () => {
  const f = fixture();
  f.setData({
    ...configurations(),
    help: {
      communityUrls: { "zh-CN": "https://", "en-US": null },
      feedback: { mode: "disabled", url: null },
    },
  });
  const view = await f.read();
  assert.equal(view.status, "ready");
  if (view.status === "ready") {
    assert.equal(view.welcome, "Welcome");
    assert.deepEqual(view.help, { status: "unavailable" });
    assert.equal(view.desktop.status, "ready");
  }
});

test("a one-sided kind/version omission is incomplete metadata, not an unsupported older backend", async () => {
  for (const missing of ["data", "version"]) {
    const f = fixture();
    if (missing === "data") {
      const { desktop: _desktop, ...rest } = configurations();
      f.setData(rest);
    } else f.setVersions({ "new-chat": 0, scenes: 0, help: 0, "plugin-store": 0 });
    const view = await f.read();
    assert.equal(view.status, "ready");
    if (view.status === "ready") assert.deepEqual(view.desktop, { status: "unavailable" });
  }
});
