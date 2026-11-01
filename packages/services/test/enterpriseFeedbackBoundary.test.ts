import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UWorkClientPresentation } from "@zcode/shared";
import { createFeedbackService } from "../src/feedback/feedbackService.js";
import { createOAuthService } from "../src/oauth/oauthService.js";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";
import { setDataBaseDir } from "../src/paths.js";
import { FeedbackHttpClient } from "../src/feedback/feedbackHttpClient.js";
import { FeedbackLocalTicketStore } from "../src/feedback/feedbackLocalTicketStore.js";
import { createEnterpriseIdentityService } from "../src/enterprise-identity/enterpriseIdentityService.js";
import {
  readEnterpriseIdentityAuthority,
  disposeEnterpriseIdentityService,
} from "../src/enterprise-identity/identityServiceLifecycle.js";
import type { IEnterpriseIdentityService } from "../src/enterprise-identity/contract.js";

async function isolatedFeedback(
  readClientPresentation: () => Promise<UWorkClientPresentation>,
  beforeResponse?: () => Promise<void>,
  identity?: IEnterpriseIdentityService,
) {
  const root = await mkdtemp(join(tmpdir(), "uwork-feedback-cancellation-"));
  setDataBaseDir(root);
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url ?? "");
    await beforeResponse?.();
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ code: 0, data: { ticket_id: "controlled", status: "open", created_at: 1 } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const credentials = { load: async () => null, save: async () => {}, delete: async () => {} };
  const apiClient = createNodeApiClient({ resolveZCodeEndpointOrigin: () => origin });
  const service = createFeedbackService({
    credentialService: credentials,
    oauthService: createOAuthService(credentials, { apiClient }),
    apiClient,
    apiBaseUrl: `${origin}/api/v1`,
    getDeviceMid: () => "controlled-device",
    readClientPresentation,
    ...(identity ? { readIdentityAuthority: () => readEnterpriseIdentityAuthority(identity) } : {}),
  });
  return {
    root,
    service,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setDataBaseDir(null);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("actual managed feedback RPC cannot reach legacy ticket or attachment HTTP, including direct callers", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-feedback-boundary-"));
  setDataBaseDir(root);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ code: 0, data: { ticket_id: "controlled", status: "open", created_at: 1 } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const credentials = { load: async () => null, save: async () => {}, delete: async () => {} };
  const apiClient = createNodeApiClient({ resolveZCodeEndpointOrigin: () => origin });
  let view: UWorkClientPresentation = { status: "unavailable" };
  const service = createFeedbackService({
    credentialService: credentials,
    oauthService: createOAuthService(credentials, { apiClient }),
    apiClient,
    apiBaseUrl: `${origin}/api/v1`,
    getDeviceMid: () => "controlled-device",
    readClientPresentation: async () => view,
  });
  const file = join(root, "owned.txt");
  await writeFile(file, "controlled");
  try {
    const input = { title: "Controlled", description: "Owned fixture", type: "bug" as const };
    const base = {
      status: "ready" as const,
      version: 0,
      welcome: "",
      riskNotice: "Verify",
      riskPrefix: "AI",
      scenes: { status: "unsupported" as const },
      desktop: { status: "unsupported" as const },
      pluginStore: { status: "unsupported" as const },
    };
    const managed: UWorkClientPresentation[] = [
      { status: "unavailable" },
      { ...base, help: { status: "unsupported" } },
      {
        ...base,
        help: {
          status: "ready",
          version: 0,
          data: {
            communityUrls: { "zh-CN": null, "en-US": null },
            feedback: { mode: "disabled", url: null },
          },
        },
      },
      {
        ...base,
        help: {
          status: "ready",
          version: 1,
          data: {
            communityUrls: { "zh-CN": null, "en-US": null },
            feedback: { mode: "external", url: "https://help.example.test/feedback" },
          },
        },
      },
    ];
    for (const current of managed) {
      view = current;
      for (const call of [
        () => service.create(input),
        () => service.get("controlled"),
        () => service.comment("controlled", "Owned"),
        () => service.list(),
        () => service.uploadAttachment("controlled", "image", { path: file }),
        () =>
          service.uploadAttachmentWithProgress("controlled", "image", { path: file }, "progress"),
        () =>
          service.uploadAttachmentData("controlled", "image", {
            dataBase64: "eA==",
            filename: "x.png",
            contentType: "image/png",
          }),
        () => service.attachLogsFromExport("controlled"),
      ])
        await assert.rejects(call(), /enterprise_feedback_/);
    }
    assert.deepEqual(requests, []);
    view = { status: "unmanaged" };
    assert.equal((await service.create(input)).id, "controlled");
    assert.deepEqual(requests, ["/api/v1/feedback/ticket"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
});

test("a response dispatched while unmanaged cannot be consumed after switching to managed", async () => {
  let view: UWorkClientPresentation = { status: "unmanaged" };
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await isolatedFeedback(
    async () => view,
    async () => {
      entered();
      await hold;
    },
  );
  try {
    const operation = f.service.create({ title: "Controlled", description: "Owned", type: "bug" });
    await started;
    view = { status: "unavailable" };
    release();
    await assert.rejects(operation, /enterprise_feedback_unavailable/);
    assert.equal(
      f.requests.length,
      1,
      "the earlier admitted request cannot be unsent, but no new request is allowed",
    );
  } finally {
    release();
    await f.close();
  }
});

test("an unmanaged reply cannot cross identity generation or populate the new owner's local tickets", async () => {
  const identity = createEnterpriseIdentityService({
    credentials: { load: async () => null, save: async () => {}, delete: async () => {} },
    readClientPresentation: async () => ({ status: "unmanaged" }),
  });
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holdFirst = true;
  const f = await isolatedFeedback(
    () => identity.readClientPresentation(),
    async () => {
      if (holdFirst) {
        holdFirst = false;
        enter();
        await hold;
      }
    },
    identity,
  );
  try {
    const operation = f.service.create({ title: "Old owner", description: "Owned", type: "bug" });
    void operation.catch(() => {});
    await entered;
    const before = await identity.getView();
    await identity.logout();
    assert.notEqual((await identity.getView()).revision, before.revision);
    assert.deepEqual(await identity.readClientPresentation(), { status: "unmanaged" });
    release();
    await assert.rejects(operation, /enterprise_identity_changed|abort/iu);
    assert.deepEqual(await f.service.list(), { items: [], total: 0 });
    assert.equal(
      (await f.service.create({ title: "New owner", description: "Owned", type: "bug" })).id,
      "controlled",
    );
    assert.equal((await f.service.list()).total, 1);
  } finally {
    release();
    await f.close();
    await disposeEnterpriseIdentityService(identity);
  }
});

test("local ticket writes check the operation receipt after asynchronous preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-feedback-local-receipt-"));
  const store = new FeedbackLocalTicketStore(root);
  const controller = new AbortController();
  try {
    const writing = store.upsert(
      "owned-device",
      {
        id: "old-owner",
        title: "Owned",
        type: "bug",
        status: "已提交",
        created_at: "2026-10-17T00:00:00Z",
        updated_at: "2026-10-17T00:00:00Z",
      },
      () => controller.signal.throwIfAborted(),
    );
    controller.abort(new Error("owned receipt revoked"));
    await assert.rejects(writing, /owned receipt revoked/);
    assert.deepEqual(await store.list("owned-device"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelUpload during private metadata preparation cannot request late upload credentials", async () => {
  let release!: (view: UWorkClientPresentation) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<UWorkClientPresentation>((resolve) => {
    release = resolve;
  });
  const f = await isolatedFeedback(async () => {
    entered();
    return pending;
  });
  try {
    const path = join(f.root, "owned-upload.txt");
    await writeFile(path, "owned");
    const operation = f.service.uploadAttachmentWithProgress(
      "controlled",
      "image",
      { path },
      "owned-progress",
    );
    await started;
    await f.service.cancelUpload("owned-progress");
    release({ status: "unmanaged" });
    await assert.rejects(operation, /abort|cancel/iu);
    assert.deepEqual(f.requests, []);
  } finally {
    release({ status: "unmanaged" });
    await f.close();
  }
});

test("cancelCreate during private metadata preparation cannot produce a late legacy request", async () => {
  let release!: (view: UWorkClientPresentation) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<UWorkClientPresentation>((resolve) => {
    release = resolve;
  });
  const f = await isolatedFeedback(async () => {
    entered();
    return pending;
  });
  try {
    const operation = f.service.create(
      { title: "Controlled", description: "Owned", type: "bug" },
      { operationId: "owned-cancel" },
    );
    await started;
    await f.service.cancelCreate("owned-cancel");
    release({ status: "unmanaged" });
    await assert.rejects(operation, /abort|cancel/iu);
    assert.deepEqual(f.requests, []);
  } finally {
    release({ status: "unmanaged" });
    await f.close();
  }
});

test("the direct OSS transport rechecks mode after upload credentials have been decoded", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-feedback-oss-"));
  const file = join(root, "owned.txt");
  await writeFile(file, "owned");
  let uploads = 0,
    decoded = false,
    managed = false;
  const server = createServer((_request, response) => {
    uploads++;
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  class CredentialResponse extends Response {
    override async json(): Promise<unknown> {
      const value: unknown = await super.json();
      decoded = true;
      return value;
    }
  }
  const client = new FeedbackHttpClient({
    baseUrl: `${origin}/api/v1`,
    getAuthHeaders: async () => ({ "X-Device-Mid": "controlled" }),
    apiClient: {
      request: async () =>
        new CredentialResponse(
          JSON.stringify({
            code: 0,
            data: {
              attachment_id: "owned",
              max_size: 100,
              callback: { url: `${origin}/callback`, body: "owned", content_type: "text/plain" },
              oss: {
                host: `${origin}/upload`,
                path: "owned",
                policy: "synthetic",
                x_oss_signature: "synthetic",
                x_oss_signature_version: "synthetic",
                x_oss_credential: "synthetic",
                x_oss_security_token: "synthetic",
                x_oss_date: "synthetic",
              },
            },
          }),
        ),
    },
    assertLegacyFeedbackAllowed: async () => {
      if (managed) throw Error("enterprise_feedback_disabled");
      if (decoded)
        queueMicrotask(() => {
          managed = true;
        });
    },
  });
  try {
    await assert.rejects(
      client.uploadFile("owned", "image", file, "owned.txt", "text/plain"),
      /enterprise_feedback_disabled/,
    );
    assert.equal(uploads, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel during the upload-credential HTTP guard reaches the final dispatch signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-feedback-http-cancel-"));
  const file = join(root, "owned.txt");
  await writeFile(file, "owned");
  let origin = "",
    tcp = 0,
    calls = 0,
    checks = 0;
  const server = createServer((_request, response) => {
    tcp++;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        code: 0,
        data: {
          attachment_id: "owned",
          max_size: 100,
          callback: { url: `${origin}/callback`, body: "owned", content_type: "text/plain" },
          oss: {
            host: `${origin}/upload`,
            path: "owned",
            policy: "synthetic",
            x_oss_signature: "synthetic",
            x_oss_signature_version: "synthetic",
            x_oss_credential: "synthetic",
            x_oss_security_token: "synthetic",
            x_oss_date: "synthetic",
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = createNodeApiClient({ resolveZCodeEndpointOrigin: () => origin });
  const client = new FeedbackHttpClient({
    baseUrl: `${origin}/api/v1`,
    getAuthHeaders: async () => ({ "X-Device-Mid": "controlled" }),
    apiClient: {
      request: (input, init) => {
        calls++;
        return transport.request(input, init);
      },
    },
    assertLegacyFeedbackAllowed: async () => {
      if (++checks === 1) {
        entered();
        await hold;
      }
    },
  });
  const controller = new AbortController();
  try {
    const operation = client.uploadFile("owned", "image", file, "owned.txt", "text/plain", {
      signal: controller.signal,
    });
    await started;
    controller.abort();
    release();
    await assert.rejects(operation, /abort|cancel/iu);
    assert.equal(calls, 0);
    assert.equal(tcp, 0);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
