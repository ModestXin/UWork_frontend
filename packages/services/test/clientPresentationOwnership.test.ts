import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnterpriseIdentityService } from "../src/enterprise-identity/enterpriseIdentityService.js";
import {
  disposeEnterpriseIdentityService,
  readEnterpriseIdentityTurnPresentation,
} from "../src/enterprise-identity/identityServiceLifecycle.js";
import {
  createClientPresentationReader,
  readClientTurnPresentation,
} from "../src/enterprise-identity/clientPresentation.js";
import {
  UWorkBackendSessionError,
  type UWorkBackendSession,
} from "../src/enterprise-identity/backendSessionContract.js";
import type { UWorkClientPresentation } from "@zcode/shared";

test("identity facade coalesces only in-flight reads and fences late success after logout", async () => {
  let reads = 0;
  let finish!: (view: UWorkClientPresentation) => void;
  const service = createEnterpriseIdentityService({
    credentials: { load: async () => null, save: async () => {}, delete: async () => {} },
    readClientPresentation: () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    const first = service.readClientPresentation();
    const simultaneous = service.readClientPresentation();
    assert.equal(reads, 1);
    await service.logout();
    finish({ status: "unmanaged" });
    assert.deepEqual(await first, { status: "unavailable" });
    assert.deepEqual(await simultaneous, { status: "unavailable" });
    const next = service.readClientPresentation();
    assert.equal(reads, 2);
    finish({ status: "unmanaged" });
    assert.deepEqual(await next, { status: "unmanaged" });
  } finally {
    await disposeEnterpriseIdentityService(service);
  }
});

test("private turn metadata propagates owner invalidation/cancellation while public display becomes unavailable", async () => {
  const backend: UWorkBackendSession = {
    async run() {
      throw new UWorkBackendSessionError("enterprise_identity_changed");
    },
  };
  const read = createClientPresentationReader(backend);
  assert.deepEqual(await read(), { status: "unavailable" });
  await assert.rejects(
    readClientTurnPresentation(read),
    (error: unknown) =>
      error instanceof UWorkBackendSessionError && error.code === "enterprise_identity_changed",
  );
  const controller = new AbortController();
  controller.abort(new Error("controlled turn cancellation"));
  await assert.rejects(
    readClientTurnPresentation(read, controller.signal),
    /controlled turn cancellation/,
  );
});

test("managed unavailable metadata yields terminal without reviving a previous ready surface", async () => {
  assert.deepEqual(await readClientTurnPresentation(async () => ({ status: "unavailable" })), {
    presentationStatus: "unavailable",
    presentationSurface: "terminal",
  });
  assert.deepEqual(await readClientTurnPresentation(async () => ({ status: "unmanaged" })), {
    presentationStatus: "unmanaged",
  });
});

test("identity's finite private port preserves same-revision issuer failures while display stays unavailable", async () => {
  for (const code of [
    "enterprise_identity_changed",
    "enterprise_configuration_changed",
    "enterprise_authorization_cancelled",
  ]) {
    const service = createEnterpriseIdentityService({
      credentials: { load: async () => null, save: async () => {}, delete: async () => {} },
      readClientPresentation: createClientPresentationReader({
        async run() {
          throw new UWorkBackendSessionError(code);
        },
      }),
    });
    try {
      const before = await service.getView();
      assert.deepEqual(await service.readClientPresentation(), { status: "unavailable" });
      await assert.rejects(
        readEnterpriseIdentityTurnPresentation(service),
        (error: unknown) => error instanceof UWorkBackendSessionError && error.code === code,
      );
      assert.equal((await service.getView()).revision, before.revision);
    } finally {
      await disposeEnterpriseIdentityService(service);
    }
  }
});

test("a display-only identity cannot substitute its public getter for a missing private turn port", async () => {
  const service = createEnterpriseIdentityService({
    credentials: { load: async () => null, save: async () => {}, delete: async () => {} },
  });
  try {
    assert.deepEqual(await service.readClientPresentation(), { status: "unmanaged" });
    await assert.rejects(
      readEnterpriseIdentityTurnPresentation(service),
      /enterprise_identity_changed/,
    );
  } finally {
    await disposeEnterpriseIdentityService(service);
  }
});

for (const cause of ["caller", "logout", "dispose"] as const) {
  test(`private port combines caller/owner signals and rejects late metadata after ${cause}`, async () => {
    let finish!: (view: UWorkClientPresentation) => void;
    let signal!: AbortSignal;
    const service = createEnterpriseIdentityService({
      credentials: { load: async () => null, save: async () => {}, delete: async () => {} },
      readClientPresentation: (options) => {
        assert.equal(options?.propagateInvalidation, true);
        signal = options!.signal!;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const controller = new AbortController();
    const pending = readEnterpriseIdentityTurnPresentation(service, controller.signal);
    void pending.catch(() => {});
    let disposing: Promise<void> | undefined;
    try {
      assert.notEqual(signal, controller.signal);
      if (cause === "caller") controller.abort(new Error("controlled caller cancelled"));
      else if (cause === "logout") await service.logout();
      else {
        disposing = disposeEnterpriseIdentityService(service);
        await assert.rejects(
          readEnterpriseIdentityTurnPresentation(service),
          /enterprise_identity_changed/,
        );
      }
      assert.equal(signal.aborted, true);
      finish({ status: "unmanaged" });
      await assert.rejects(
        pending,
        cause === "caller" ? /controlled caller cancelled/ : /enterprise_identity_changed/,
      );
    } finally {
      finish({ status: "unmanaged" });
      await disposing;
      await disposeEnterpriseIdentityService(service);
    }
  });
}
