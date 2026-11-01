import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayFixture, MODEL, deferred } from "./enterpriseGatewayCatalog.fixture.js";
import { withFileLock } from "@zcode/shared/node";
import { providerSettingsTrustedGatewayProvisioning } from "../src/model-provider/providerFacadeServices.js";
import {
  type ProviderRegistryFacadeSource,
  type ProviderRegistryServiceSnapshot,
} from "@zcode/provider";
import { createGatewayModelSelectionSource } from "../src/model-provider/gatewayModelSelectionSource.js";

async function until(read: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await read()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail("controlled async operation did not settle");
}

test("real identity logout clears the previously committed managed catalog through its original Writer", async (t) => {
  const f = await gatewayFixture(t);
  await f.login();
  assert.equal((await f.gateway.sync("login")).committed, true);
  assert.deepEqual(await f.models(), [MODEL("A")]);
  await f.identity.logout();
  assert.equal((await f.identity.getView()).status, "signed-out");
  // The real async Writer must be allowed to finish; no scheduler, model or manually rewritten config is involved.
  for (
    let attempt = 0;
    attempt < 30 && f.runtime.registryService.getProvider("ucas")?.models.length;
    attempt++
  )
    await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(await f.models(), []);
  const stored = JSON.parse(await f.raw());
  const ucas = stored.config.providerConfigRules.providerRules.find(
    (rule: { providerId: string }) => rule.providerId === "ucas",
  );
  assert.deepEqual(ucas.config.enterpriseModelIds, []);
  assert.deepEqual(ucas.config.enterpriseModelNames, {});
});

test("a failed cleanup leaves the disk marker but never re-admits the revoked managed candidate", async (t) => {
  const f = await gatewayFixture(t);
  await f.login();
  await f.gateway.sync("login");
  f.failClear();
  await f.identity.logout();
  await until(() => f.completedClears() > 0);
  assert.ok((await f.raw()).includes(MODEL("A")));
  assert.deepEqual(await f.models(), []);
  assert.equal((await f.gateway.getView()).models, null);
});

test(
  "B authentication alone admits no old catalog; B commits before an obsolete clear is released",
  { timeout: 5000 },
  async (t) => {
    const f = await gatewayFixture(t);
    await f.login();
    await f.gateway.sync("login");
    const clearing = deferred(),
      releaseClear = deferred(),
      readingB = deferred(),
      releaseB = deferred();
    f.holdApply(async (input) => {
      if (input.clearManagedCatalog) {
        clearing.resolve();
        await releaseClear.promise;
      }
    });
    f.holdModels(async (slot) => {
      if (slot === "B") {
        readingB.resolve();
        await releaseB.promise;
      }
    });
    try {
      await f.identity.logout();
      await clearing.promise;
      await f.login("B");
      assert.deepEqual(await f.models(), []);
      const syncing = f.gateway.sync("login");
      await readingB.promise;
      assert.deepEqual(await f.models(), []);
      releaseB.resolve();
      assert.equal((await syncing).committed, true);
      const before = await f.raw();
      releaseClear.resolve();
      await until(() => f.completedClears() > 0);
      assert.equal(await f.raw(), before);
      assert.deepEqual(await f.models(), [MODEL("B")]);
      const selected = await f.runtime.modelSelection.getView({
        selection: {
          providerId: "ucas",
          modelId: MODEL("B"),
          options: { reasoningLevel: "disabled" },
        },
      });
      assert.equal(selected.effectiveSelection?.modelId, MODEL("B"));
    } finally {
      releaseB.resolve();
      releaseClear.resolve();
    }
  },
);

test(
  "clear queued behind the actual Repository lock is denied after B replaces the identity",
  { timeout: 5000 },
  async (t) => {
    const f = await gatewayFixture(t);
    await f.login();
    await f.gateway.sync("login");
    const locked = deferred(),
      release = deferred(),
      prechecked = deferred();
    const checks: boolean[] = [];
    f.holdApply(async (input) => {
      if (!input.clearManagedCatalog) return;
      return {
        ...input,
        isCurrent: () => {
          const current = input.isCurrent!();
          checks.push(current);
          if (checks.length === 1) prechecked.resolve();
          return current;
        },
      };
    });
    const lock = withFileLock(f.path, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    let syncing: ReturnType<typeof f.gateway.sync> | undefined;
    try {
      await f.identity.logout();
      await prechecked.promise;
      await f.login("B");
      syncing = f.gateway.sync("login");
      assert.deepEqual(await f.models(), []);
    } finally {
      release.resolve();
      await lock;
    }
    assert.equal((await syncing!).committed, true);
    await until(() => f.completedClears() > 0);
    assert.equal(
      checks[0],
      true,
      "the old clear passed its check before waiting for the real file lock",
    );
    assert.ok(
      checks.length >= 2 && checks.slice(1).includes(false),
      "the same callback was denied after the identity changed inside the locked Writer",
    );
    assert.deepEqual(await f.models(), [MODEL("B")]);
    assert.equal(
      (await f.runtime.modelSelection.getView()).providers[0]?.models[0]?.displayName,
      "Model B",
    );
  },
);

test("the original private Writer clears only a still-managed UCAS and public provisioning cannot submit that command", async (t) => {
  const f = await gatewayFixture(t);
  await f.login();
  await f.gateway.sync("login");
  await f.runtime.providerSettings.savePersonalProviderOverlay("ucas", {
    access: { type: "api-key", apiKey: "controlled-personal-key" },
  });
  const before = await f.raw(),
    models = await f.models();
  await assert.rejects(
    f.runtime.providerSettings[providerSettingsTrustedGatewayProvisioning]({
      baseUrl: "https://different.example.test/v1",
      clearManagedCatalog: true,
    }),
    /enterprise_identity_changed/,
  );
  await f.runtime.providerSettings[providerSettingsTrustedGatewayProvisioning]({
    baseUrl: "https://different.example.test/v1",
    clearManagedCatalog: true,
    isCurrent: () => true,
  });
  assert.equal(
    await f.raw(),
    before,
    "ordinary connection, endpoint, membership and model preferences remain byte-identical",
  );
  await assert.rejects(
    f.runtime.providerSettings.applyUcasGatewayProvisioning({
      baseUrl: "https://different.example.test/v1",
      clearManagedCatalog: true,
    } as never),
    /enterprise_session_private_only/,
  );
  await f.identity.logout();
  await until(() => f.completedClears() > 0);
  assert.equal(await f.raw(), before);
  assert.deepEqual(await f.models(), models);
});

test(
  "an A models response delivered after logout cannot publish over B",
  { timeout: 5000 },
  async (t) => {
    const f = await gatewayFixture(t);
    await f.login();
    await f.gateway.sync("login");
    const entered = deferred(),
      release = deferred();
    f.holdModels(async (slot) => {
      if (slot === "A") {
        entered.resolve();
        await release.promise;
      }
    });
    const old = f.gateway.sync("refresh");
    await entered.promise;
    let next: ReturnType<typeof f.gateway.sync> | undefined;
    try {
      await f.identity.logout();
      await f.login("B");
      next = f.gateway.sync("login");
    } finally {
      release.resolve();
    }
    assert.equal((await old).committed, false);
    assert.equal((await next!).committed, true);
    assert.deepEqual(await f.models(), [MODEL("B")]);
  },
);

test("the original model event revokes managed candidates before the signed-out view is delivered", async (t) => {
  const f = await gatewayFixture(t);
  await f.login();
  const events: string[][] = [];
  const modelSubscription = f.runtime.modelSelection.onDidChange((view) =>
    events.push(view.providers.flatMap((p) => p.models.map((m) => m.modelId))),
  );
  await f.gateway.sync("login");
  await until(() => events.some((models) => models.includes(MODEL("A"))));
  const signedOut: string[][] = [];
  const identitySubscription = f.identity.onDidChange((view) => {
    if (view.status === "signed-out") signedOut.push(events.at(-1) ?? ["missing-model-event"]);
  });
  try {
    await f.identity.logout();
    assert.ok(signedOut.length > 0);
    assert.deepEqual(
      signedOut,
      signedOut.map(() => []),
    );
  } finally {
    identitySubscription.dispose();
    modelSubscription.dispose();
  }
});

test("the narrow source filters before facade selection without cloning ordinary provider or snapshot owners", async (t) => {
  const f = await gatewayFixture(t);
  await f.login();
  await f.gateway.sync("login");
  const original = f.runtime.registryService.getSnapshot()!;
  const ucas = original.registry.providers.find((p) => p.providerId === "ucas")!;
  await f.runtime.providerSettings.savePersonalProviderOverlay("ucas", {
    access: { type: "api-key", apiKey: "controlled-personal-key" },
  });
  const ordinaryConfig = f.runtime.registryService.getProvider("ucas")!.config;
  const other = {
    providerId: "personal",
    providerName: "Personal",
    config: ordinaryConfig,
    models: ucas.models,
  };
  let current: ProviderRegistryServiceSnapshot = {
    ...original,
    registry: { revision: original.registry.revision, providers: [ucas, other] },
  };
  const base: ProviderRegistryFacadeSource = {
    getSnapshot: () => current,
    getView: () => current.registry,
    refresh: async () => current,
    onDidChange: () => () => {},
  };
  const projected = createGatewayModelSelectionSource(base);
  projected.bind({ isCurrent: () => false, onDidChange: () => ({ dispose() {} }) });
  try {
    const snapshot = projected.source.getSnapshot()!;
    assert.equal(snapshot.account, original.account);
    assert.equal(snapshot.config, original.config);
    assert.equal(snapshot.resolution, original.resolution);
    assert.deepEqual(snapshot.registry.providers, [other]);
    assert.equal(snapshot.registry.providers[0], other);
    assert.equal(base.getView().providers[0], ucas);
    const ordinary = {
      providerId: ucas.providerId,
      providerName: ucas.providerName,
      config: other.config,
      models: ucas.models,
    };
    current = { ...current, registry: { ...current.registry, providers: [ordinary, other] } };
    assert.equal(projected.source.getView().providers[0], ordinary);
    assert.equal(projected.source.getView().providers[1], other);
  } finally {
    projected.dispose();
  }
});

test(
  "revoked managed candidates disappear from the original facade before the real Writer can acquire its work",
  { timeout: 5000 },
  async (t) => {
    const f = await gatewayFixture(t);
    await f.login();
    await f.gateway.sync("login");
    const entered = deferred(),
      release = deferred();
    f.holdApply(async (input) => {
      if (input.clearManagedCatalog) {
        entered.resolve();
        await release.promise;
      }
    });
    try {
      await f.identity.logout();
      await entered.promise;
      assert.ok((await f.raw()).includes(MODEL("A")), "disk is deliberately still old");
      assert.deepEqual(
        await f.models(),
        [],
        "current candidate reads must not wait for disk cleanup",
      );
    } finally {
      release.resolve();
    }
  },
);
