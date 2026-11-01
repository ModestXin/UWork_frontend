import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";
import { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import { NodeApiClient } from "../src/providers/api/nodeApiClient.js";
import { createHostApiNetworkTransport } from "../src/providers/api/nodeApiNetwork.js";
import { ConversationShareService } from "../src/conversation-share/conversationShareService.js";
import { createUWorkPublicationPolicy } from "../src/conversation-share/uworkPublicationPolicy.js";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, type ConversationShareAccessMode } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

const prepare = {
  client_request_id: "controlled-request",
  title: "Controlled share",
  schema_version: 1 as const,
  access_mode: "private" as const,
  payload_sha256: "a".repeat(64),
  artifact_count: 0,
};
async function fixture(t: TestContext, useDefaultEndpoint = false) {
  const paths: string[] = [];
  let sharing = {
    publish: "internet",
    collaborate: "disabled",
    files: false,
    wechat: false,
    wecom: false,
  };
  let malformed = false;
  let security = {
    allowShell: false,
    allowFilesystem: false,
    allowNetwork: true,
    dangerousSkills: false,
    allowedDomains: [] as string[],
  };
  let endpointResolve: (() => void | Promise<void>) | undefined;
  let resolveNetwork: (() => void | Promise<void>) | undefined;
  let resolveDispatcher: (() => void | Promise<void>) | undefined;
  let afterExternal: (() => void) | undefined;
  let afterToken: (() => void) | undefined;
  let backendRequests = 0;
  let afterSleep: (() => void) | undefined;
  let pendingOnce = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/api/client/authorize") {
      backendRequests++;
      assert.equal(req.headers.authorization, "Bearer backend-synthetic");
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        action: "share",
        target: "internet",
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          tenantId: "tenant",
          allowed: sharing.publish === "internet",
          ...(malformed ? {} : { sharing, security }),
        }),
      );
      return;
    }
    assert.equal(req.headers.authorization, "Bearer external-synthetic");
    paths.push(req.url!);
    afterExternal?.();
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("confirm") && pendingOnce) {
      pendingOnce = false;
      res.statusCode = 409;
      res.end(JSON.stringify({ code: 3215, msg: "Safety check pending" }));
      return;
    }
    const data = req.url?.endsWith("capabilities")
      ? {
          schema_version: 1,
          ttl_ms: 60000,
          max_rows: 100,
          max_payload_bytes: 100000,
          max_artifact_count: 10,
          max_artifact_bytes: 100000,
          max_total_artifact_bytes: 100000,
          access_modes: ["private", "public_readonly", "public_importable"],
          allowed_artifacts: [],
        }
      : req.url?.endsWith("confirm")
        ? {
            access_mode: "private",
            share_code: "controlled-code",
            share_url: "https://share.example.test/share/controlled-code",
            expires_at: Date.now() + 60000,
          }
        : {
            preparation_id: "controlled-preparation",
            access_mode: "private",
            expires_at: Date.now() + 60000,
            status: "preparing",
          };
    res.end(JSON.stringify({ code: 0, msg: "ok", data }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const identityController = new AbortController();
  let config: { backend: "uwork" | "ucas"; apiBaseUrl: string } = {
    backend: "uwork",
    apiBaseUrl: origin,
  };
  let authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: identityController.signal,
    session: {
      token: "backend-synthetic",
      issuerOrigin: origin,
      expiresAt: Date.now() + 60000,
      profile: { id: "member", tenantId: "tenant", provider: "wecom", displayName: "Controlled" },
    },
  };
  const backend = createUWorkBackendSession({
    resolveConfig: async () => config,
    readAuthority: () => authority,
    readPersistedSession: async () => ({
      revision: authority.revision,
      session: authority.session,
    }),
  });
  const policy = createUWorkPublicationPolicy(backend);
  const transport = createHostApiNetworkTransport(
    async () => {
      await resolveNetwork?.();
      return resolveDispatcher ? { caCertPath: "controlled-ca-path" } : {};
    },
    {
      createDispatcher: async () => {
        await resolveDispatcher?.();
        return new Agent();
      },
    },
  );
  t.after(() => transport.disposeAndWait());
  const client = new ConversationShareHttpClient({
    baseUrl: useDefaultEndpoint ? DEFAULT_ZCODE_ENDPOINT_ORIGIN : origin,
    apiClient: new NodeApiClient({
      fetchImpl: transport.fetch,
      resolveZCodeEndpointOrigin: async () => {
        await endpointResolve?.();
        return origin;
      },
    }),
    tokenProvider: async () => {
      afterToken?.();
      return "external-synthetic";
    },
  });
  const root = await mkdtemp(join(tmpdir(), "uwork-share-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows: ConversationRow[] = [
    {
      rowId: 1,
      turnId: "turn",
      productTurnId: "product-turn",
      entityId: "header",
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
      endedAt: 2,
      createdAt: 1,
      createdAtSeq: 1,
    },
    {
      rowId: 2,
      turnId: "turn",
      productTurnId: "product-turn",
      entityId: "message",
      kind: "userInput",
      origin: "realUser",
      text: "Controlled text",
      createdAt: 1,
      createdAtSeq: 2,
    },
  ];
  const service = new ConversationShareService({
    client,
    publicationPolicy: policy,
    conversationWorkspaceRoot: root,
    sleep: async () => {
      afterSleep?.();
    },
    zcodeAgentService: {
      conversationRowsRangeV4: async () => ({
        rows,
        hasMore: false,
        atSeq: 2,
        atRevision: 1,
        atLogEpoch: "controlled-epoch",
      }),
      conversationFileChangesV4: async () => {
        throw new Error("No files expected");
      },
      conversationAttachmentReadV4: async () => {
        throw new Error("No attachments expected");
      },
      conversationAttachmentStatV4: async () => {
        throw new Error("No attachments expected");
      },
    },
    artifactSource: {
      read: async () => {
        throw new Error("No artifacts expected");
      },
      stat: async () => {
        throw new Error("No artifacts expected");
      },
    },
  });
  return {
    paths,
    policy,
    client,
    service,
    rows,
    counts: () => backendRequests,
    sharing: (patch: Partial<typeof sharing>) => {
      sharing = { ...sharing, ...patch };
    },
    network: (patch: Partial<typeof security>) => {
      security = { ...security, ...patch };
    },
    onEndpointResolve: (fn: () => void | Promise<void>) => {
      endpointResolve = fn;
    },
    onDispatcherResolve: (fn: () => void | Promise<void>) => {
      resolveDispatcher = fn;
    },
    onNetworkResolve: (fn: () => void | Promise<void>) => {
      resolveNetwork = fn;
    },
    malformed: () => {
      malformed = true;
    },
    pending: () => {
      pendingOnce = true;
    },
    onSleep: (fn: () => void) => {
      afterSleep = fn;
    },
    onExternal: (fn: () => void) => {
      afterExternal = fn;
    },
    onToken: (fn: () => void) => {
      afterToken = fn;
    },
    logout: () => {
      identityController.abort();
      authority = { ...authority, generation: 2, session: null };
    },
    ucas: () => {
      config = { ...config, backend: "ucas" };
    },
    uwork: () => {
      config = { ...config, backend: "uwork" };
    },
  };
}
function input(accessMode: ConversationShareAccessMode = "private") {
  return {
    workspacePath: "/controlled",
    sessionId: "controlled-session",
    title: "Controlled share",
    accessMode,
    selection: { kind: "all" as const },
    clientRequestId: "controlled-request",
    disclosureAcceptedAt: 1,
  };
}

for (const mode of ["private", "public_readonly", "public_importable"] as const)
  test(`Host share ${mode} requires internet publication even when organization publishing is allowed`, async (t) => {
    const f = await fixture(t);
    f.sharing({ publish: "organization" });
    await assert.rejects(() => f.service.publish(input(mode), "controlled-operation"), {
      kind: "feature_disabled",
    });
    assert.deepEqual(f.paths, []);
  });

test("publication policy is checked after asynchronous external token lookup", async (t) => {
  const f = await fixture(t);
  f.onToken(() => f.sharing({ publish: "disabled" }));
  await assert.rejects(
    () => f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
    { kind: "feature_disabled" },
  );
  assert.deepEqual(f.paths, []);
});

test("an internet-authorized Host uses the existing external service without forwarding its backend credential", async (t) => {
  const f = await fixture(t);
  const result = await f.service.publish(input(), "controlled-operation");
  assert.equal(result.share_code, "controlled-code");
  assert.deepEqual(f.paths, [
    "/shares/capabilities",
    "/shares/preparations",
    "/shares/preparations/controlled-preparation/confirm",
  ]);
  assert.ok(f.counts() >= 7);
});

test("missing sharing metadata fails closed before any external request", async (t) => {
  const f = await fixture(t);
  f.malformed();
  await assert.rejects(() => f.service.publish(input(), "controlled-operation"), {
    kind: "feature_disabled",
  });
  assert.deepEqual(f.paths, []);
});

test("artifact preparations require the current files permission", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () =>
      f.policy.run((authorization) =>
        f.client.createPreparation({ ...prepare, artifact_count: 1 }, authorization),
      ),
    { kind: "feature_disabled" },
  );
  assert.deepEqual(f.paths, []);
});

test("policy revocation during preparation suppresses its result and prevents confirmation", async (t) => {
  const f = await fixture(t);
  f.onExternal(() => {
    if (f.paths.at(-1) === "/shares/preparations") f.sharing({ publish: "disabled" });
  });
  await assert.rejects(() => f.service.publish(input(), "controlled-operation"), {
    kind: "feature_disabled",
  });
  assert.deepEqual(f.paths, ["/shares/capabilities", "/shares/preparations"]);
});

test("logout during asynchronous token lookup cannot dispatch an external preparation", async (t) => {
  const f = await fixture(t);
  f.onToken(f.logout);
  await assert.rejects(
    () => f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
    { kind: "feature_disabled" },
  );
  assert.deepEqual(f.paths, []);
});

test("logout after an external request cannot publish a late success or confirm", async (t) => {
  const f = await fixture(t);
  f.onExternal(f.logout);
  await assert.rejects(() => f.service.publish(input(), "controlled-operation"));
  assert.deepEqual(f.paths, ["/shares/capabilities"]);
});

test("final confirmation checks the current policy after its own asynchronous token lookup", async (t) => {
  const f = await fixture(t);
  let lookups = 0;
  f.onToken(() => {
    if (++lookups === 3) f.sharing({ publish: "disabled" });
  });
  await assert.rejects(() => f.service.publish(input(), "controlled-operation"), {
    kind: "feature_disabled",
  });
  assert.deepEqual(f.paths, ["/shares/capabilities", "/shares/preparations"]);
});

test("safety-check retry reauthorizes without recreating or re-uploading a preparation", async (t) => {
  const f = await fixture(t);
  f.pending();
  f.onSleep(() => f.sharing({ publish: "disabled" }));
  await assert.rejects(() => f.service.publish(input(), "controlled-operation"), {
    kind: "feature_disabled",
  });
  assert.equal(f.paths.filter((path) => path === "/shares/preparations").length, 1);
  assert.equal(f.paths.filter((path) => path.endsWith("confirm")).length, 1);
});

test("explicit UCAS publication retains its existing external service behavior", async (t) => {
  const f = await fixture(t);
  f.ucas();
  f.sharing({ publish: "disabled" });
  const result = await f.service.publish(input(), "controlled-operation");
  assert.equal(result.share_code, "controlled-code");
  assert.equal(f.counts(), 0);
  assert.equal(f.paths.length, 3);
});

test("an initially unmanaged publication cannot bypass a newly managed profile", async (t) => {
  const f = await fixture(t);
  f.ucas();
  f.onToken(f.uwork);
  await assert.rejects(
    () => f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
    { kind: "feature_disabled" },
  );
  assert.deepEqual(f.paths, []);
});

test("switching a managed publication to UCAS cannot reuse its captured owner", async (t) => {
  const f = await fixture(t);
  f.onToken(f.ucas);
  await assert.rejects(
    () => f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
    { kind: "feature_disabled" },
  );
  assert.deepEqual(f.paths, []);
});

test("late confirmation after policy revocation is suppressed without retry or rollback claims", async (t) => {
  const f = await fixture(t);
  f.onExternal(() => {
    if (f.paths.at(-1)?.endsWith("confirm")) f.sharing({ publish: "disabled" });
  });
  await assert.rejects(() => f.service.publish(input(), "controlled-operation"), {
    kind: "feature_disabled",
  });
  assert.equal(f.paths.filter((path) => path.endsWith("confirm")).length, 1);
});

test("each artifact upload checks files permission after preparation has already succeeded", async (t) => {
  const f = await fixture(t);
  f.sharing({ files: true });
  await assert.rejects(
    () =>
      f.policy.run(async (authorization) => {
        await f.client.createPreparation({ ...prepare, artifact_count: 1 }, authorization);
        f.sharing({ files: false });
        return f.client.uploadArtifact(
          "controlled-preparation",
          {
            artifact_id: "artifact",
            logical_artifact_key: "logical",
            producer_product_turn_id: "product-turn",
            artifact_version: 1,
            state: "current",
            ref: "zcode-artifact://share/artifact",
            artifact_type: "text",
            display_name: "controlled.txt",
            extension: "txt",
            mime_type: "text/plain",
            size_bytes: 1,
            sha256: "a".repeat(64),
          },
          new Blob(["a"]),
          authorization,
        );
      }),
    { kind: "feature_disabled" },
  );
  assert.deepEqual(f.paths, ["/shares/preparations"]);
});

test("actual NodeApiClient does not dispatch after policy revocation during endpoint resolution", async (t) => {
  const f = await fixture(t);
  f.onEndpointResolve(() => f.sharing({ publish: "disabled" }));
  await assert.rejects(() =>
    f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
  );
  assert.deepEqual(
    f.paths,
    [],
    "HTTP body must not leave the Host after endpoint resolution revocation",
  );
});

test("actual Host network transport rechecks after asynchronous proxy settings resolution", async (t) => {
  const f = await fixture(t);
  f.onNetworkResolve(() => f.sharing({ publish: "disabled" }));
  await assert.rejects(() =>
    f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
  );
  assert.deepEqual(
    f.paths,
    [],
    "HTTP body must not leave the Host after network configuration revocation",
  );
});

for (const blocked of ["network", "domain"] as const)
  test(`the actual publication URL is rejected by enterprise ${blocked} policy before fetch`, async (t) => {
    const f = await fixture(t);
    f.network(
      blocked === "network"
        ? { allowNetwork: false }
        : { allowedDomains: ["approved.example.test"] },
    );
    await assert.rejects(() =>
      f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
    );
    assert.deepEqual(f.paths, []);
  });

test("actual Host network transport rechecks after asynchronous dispatcher initialization", async (t) => {
  const f = await fixture(t);
  f.onDispatcherResolve(() => f.sharing({ publish: "disabled" }));
  await assert.rejects(() =>
    f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
  );
  assert.deepEqual(
    f.paths,
    [],
    "HTTP body must not leave the Host after dispatcher initialization revocation",
  );
});

test("domain policy evaluates the rewritten endpoint rather than the original configured share URL", async (t) => {
  const f = await fixture(t, true);
  f.network({ allowedDomains: [new URL(DEFAULT_ZCODE_ENDPOINT_ORIGIN).hostname] });
  await assert.rejects(() =>
    f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
  );
  assert.deepEqual(
    f.paths,
    [],
    "the original hostname allowance cannot authorize a rewritten target",
  );
});

for (const revoked of ["network", "domain"] as const)
  test(`the response cannot publish success after ${revoked} permission is revoked in flight`, async (t) => {
    const f = await fixture(t);
    f.onExternal(() =>
      f.network(
        revoked === "network"
          ? { allowNetwork: false }
          : { allowedDomains: ["other.example.test"] },
      ),
    );
    await assert.rejects(
      () => f.policy.run((authorization) => f.client.createPreparation(prepare, authorization)),
      { kind: "feature_disabled" },
    );
    assert.deepEqual(
      f.paths,
      ["/shares/preparations"],
      "an already dispatched request is not retried or claimed rolled back",
    );
  });
