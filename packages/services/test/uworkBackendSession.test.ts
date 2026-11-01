import assert from "node:assert/strict";
import { test } from "node:test";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";

function fixture() {
  const origin = "https://backend.example.test";
  let configuration: { backend: "uwork" | "ucas"; apiBaseUrl: string } | undefined = {
    backend: "uwork",
    apiBaseUrl: origin,
  };
  const identity = new AbortController();
  let authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: identity.signal,
    session: {
      token: "synthetic-private",
      issuerOrigin: origin,
      expiresAt: Date.now() + 60000,
      profile: { id: "member", tenantId: "tenant", provider: "wecom", displayName: "Controlled" },
    },
  };
  let persisted = { revision: authority.revision, session: authority.session };
  let brokenAuthority = false;
  let storeReads = 0,
    configReads = 0;
  let stallStore: number | undefined, stallConfig: number | undefined;
  let entered!: () => void;
  const stalled = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: { url: string; headers: Headers }[] = [];
  let response: () => Response | Promise<Response> = () => Response.json({ controlled: true });
  const port = createUWorkBackendSession({
    resolveConfig: async () => {
      if (++configReads === stallConfig) {
        entered();
        await new Promise<void>(() => {});
      }
      return configuration;
    },
    readAuthority: () => {
      if (brokenAuthority) throw new Error("synthetic-private");
      return authority;
    },
    readPersistedSession: async () => {
      if (++storeReads === stallStore) {
        entered();
        await new Promise<void>(() => {});
      }
      return persisted;
    },
    fetchImpl: async (input, options) => {
      calls.push({ url: String(input), headers: new Headers(options?.headers) });
      assert.equal(options?.redirect, "error");
      return response();
    },
  });
  return {
    port,
    calls,
    response: (value: typeof response) => {
      response = value;
    },
    logout: () => {
      identity.abort();
      authority = { ...authority, generation: authority.generation + 1, session: null };
    },
    peerLogout: () => {
      persisted = { revision: persisted.revision + 1, session: null };
    },
    breakAuthority: () => {
      brokenAuthority = true;
    },
    stall: (kind: "store" | "config", at: number) => {
      if (kind === "store") stallStore = at;
      else stallConfig = at;
      return stalled;
    },
    config: (value: typeof configuration) => {
      configuration = value;
    },
  };
}

test("the backend session scopes private HTTP without exposing credentials to its caller", async () => {
  const f = fixture();
  const result = await f.port.run(
    async (scope) => {
      assert.equal(scope.tenantId, "tenant");
      assert.ok(!JSON.stringify(scope).includes("synthetic-private"));
      return (await scope.request("/api/client/authorize", { action: "execution" })).body;
    },
    { traceId: "controlled-trace" },
  );
  assert.deepEqual(result, { managed: true, value: { controlled: true } });
  assert.equal(f.calls[0]!.headers.get("authorization"), "Bearer synthetic-private");
  assert.equal(f.calls[0]!.headers.get("x-zcode-trace-id"), "controlled-trace");
});

test(
  "cancellation also bounds capture, pre-request, post-response and final private store/configuration reads",
  { timeout: 1000 },
  async () => {
    for (const [kind, maximum] of [
      ["store", 4],
      ["config", 5],
    ] as const)
      for (let at = 1; at <= maximum; at++) {
        const f = fixture(),
          controller = new AbortController();
        const waiting = f.stall(kind, at);
        const work = f.port.run((scope) => scope.request("/api/client/assets"), {
          signal: controller.signal,
        });
        await waiting;
        controller.abort();
        await assert.rejects(() => work, /enterprise_authorization_cancelled/);
      }
  },
);

test("callbacks and requests are fenced by current identity, shared revision and configuration", async () => {
  for (const mode of ["logout", "peer", "configuration"] as const) {
    const f = fixture();
    await assert.rejects(
      () =>
        f.port.run(async (scope) => {
          await scope.request("/api/client/assets");
          if (mode === "logout") f.logout();
          if (mode === "peer") f.peerLogout();
          if (mode === "configuration")
            f.config({ backend: "uwork", apiBaseUrl: "https://other.example.test" });
          return "late result";
        }),
      /enterprise_(identity|configuration)_changed/,
    );
  }
});

test("unmanaged sessions do not enter the callback, while disappearing managed configuration fails closed", async () => {
  const f = fixture();
  f.config({ backend: "ucas", apiBaseUrl: "https://legacy.example.test" });
  assert.deepEqual(
    await f.port.run(async () => {
      throw new Error("must not enter");
    }),
    { managed: false },
  );
  assert.equal(f.calls.length, 0);
  f.config({ backend: "uwork", apiBaseUrl: "https://backend.example.test" });
  await f.port.run(async () => "controlled");
  f.config(undefined);
  await assert.rejects(
    () => f.port.run(async () => "must not enter"),
    /enterprise_configuration_changed/,
  );
});

test("off-origin and non-client paths cannot receive a private session token", async () => {
  const f = fixture();
  for (const path of [
    "https://other.example.test/api/client/assets",
    "//other.example.test/api/client/assets",
    "/api/client/../auth/login",
  ]) {
    await assert.rejects(
      () => f.port.run((scope) => scope.request(path)),
      /enterprise_policy_unavailable/,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("response limits distinguish bounded downloads from small execution decisions", async () => {
  const f = fixture();
  f.response(() => Response.json({ text: "x".repeat(70000) }));
  await assert.rejects(
    () => f.port.run((scope) => scope.request("/api/client/authorize", { action: "execution" })),
    /enterprise_response_limit/,
  );
  const value = await f.port.run((scope) =>
    scope.request("/api/client/assets/controlled/download?version=1"),
  );
  assert.equal(value.managed, true);
});

test("console routes have exact private paths and a separate bounded run-input budget", async () => {
  const f = fixture();
  const accepted = await f.port.run((scope) =>
    scope.request(
      "/api/client/runs",
      { agentId: "controlled", input: "\u0000".repeat(100000) },
      { method: "POST" },
    ),
  );
  assert.equal(accepted.managed, true);
  await assert.rejects(
    () =>
      f.port.run((scope) =>
        scope.request("/api/client/runs", { input: "x".repeat(600257) }, { method: "POST" }),
      ),
    /enterprise_request_limit/,
  );
  await assert.rejects(
    () => f.port.run((scope) => scope.request("/api/client/runs?all=true")),
    /enterprise_policy_unavailable/,
  );
  await assert.rejects(
    () => f.port.run((scope) => scope.request("/api/client/runs/../credentials")),
    /enterprise_policy_unavailable/,
  );
});

test(
  "parent cancellation bounds a response body whose stream never cooperates",
  { timeout: 1000 },
  async () => {
    const f = fixture(),
      controller = new AbortController();
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.response(
      () =>
        new Response(
          new ReadableStream(
            {
              pull() {
                entered();
                return new Promise<void>(() => {});
              },
              cancel() {
                return new Promise<void>(() => {});
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    const work = f.port.run((scope) => scope.request("/api/client/assets"), {
      signal: controller.signal,
    });
    await reading;
    controller.abort();
    await assert.rejects(() => work, /enterprise_authorization_cancelled/);
  },
);

test("invalid trace identifiers fail before HTTP and callback errors are not replaced by transport errors", async () => {
  const f = fixture();
  await assert.rejects(
    () => f.port.run((scope) => scope.request("/api/client/assets"), { traceId: "bad\ntrace" }),
    /enterprise_policy_unavailable/,
  );
  assert.equal(f.calls.length, 0);
  const controlled = new Error("callback-owned-failure");
  await assert.rejects(
    () =>
      f.port.run(async () => {
        throw controlled;
      }),
    (error) => error === controlled,
  );
});

test("a private owner read failure remains a safe denial rather than exposing its raw error", async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.port.run(async () => {
        f.breakAuthority();
        return "late";
      }),
    /enterprise_identity_changed/,
  );
});

test("a backend cannot echo a private identity token into the caller's data", async () => {
  const f = fixture();
  f.response(() => Response.json({ echo: "synthetic-private" }));
  await assert.rejects(
    () => f.port.run((scope) => scope.request("/api/client/assets")),
    /enterprise_response_private/,
  );
});

test(
  "parent cancellation bounds an HTTP transport that ignores the abort signal",
  { timeout: 1000 },
  async () => {
    const f = fixture(),
      controller = new AbortController();
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.response(() => {
      entered();
      return new Promise<Response>(() => {});
    });
    const work = f.port.run((scope) => scope.request("/api/client/assets"), {
      signal: controller.signal,
    });
    await requested;
    controller.abort();
    await assert.rejects(() => work, /enterprise_authorization_cancelled/);
  },
);
