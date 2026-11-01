import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConversationShareHttpClient,
  ConversationShareClientError,
} from "../src/conversation-share/conversationShareHttpClient.js";
import { buildConversationShareConfirmRequest } from "../src/conversation-share/conversationShareIntegrity.js";
import { bytes, descriptor, fixture, rows } from "./uworkShareTestFixture.js";

const preparation = {
  client_request_id: "intent-one",
  title: "Controlled",
  schema_version: 1 as const,
  access_mode: "organization" as const,
  payload_sha256: "a".repeat(64),
  artifact_count: 0,
};
const continuation = { schema_version: 1 as const, client_request_id: "import-intent" };

test("all publication content uses one original scope across capability/prepare/upload/confirm", async () => {
  const f = fixture(),
    ports = f.createPorts();
  const client = new ConversationShareHttpClient({
    ...f.clientOptions,
    managedTransport: ports.managedTransport,
  });
  await ports.publicationPolicy.run(async (authorization) => {
    await client.getCapabilities(authorization);
    await client.createPreparation({ ...preparation, artifact_count: 1 }, authorization);
    await client.uploadArtifact("prep-one", descriptor, new Blob([bytes]), authorization);
    const confirmed = buildConversationShareConfirmRequest({
      selected_product_turn_ids: ["turn-one"],
      projection: { rows },
      artifacts: [descriptor],
      disclosure_confirmation: {
        version: 1,
        accepted_at: 1,
        acknowledged_no_secret_detection: true,
      },
    });
    assert.equal(
      (await client.confirm("prep-one", confirmed, authorization, true)).access_mode,
      "organization",
    );
  });
  assert.equal(f.counts.captures, 1);
  assert.equal(f.counts.oauth, 0);
  assert.equal(f.counts.legacy, 0);
  const upload = f.calls.find((call) => call.path.endsWith("/artifacts"));
  assert.deepEqual(upload?.body, { descriptor, content_base64: bytes.toString("base64") });
});

test("owner/logout/issuer invalidation after prepare prevents later A bytes from reaching B", async () => {
  for (const invalidate of ["replaceOwner", "logout", "changeIssuer"] as const) {
    const f = fixture(),
      ports = f.createPorts();
    const client = new ConversationShareHttpClient({
      ...f.clientOptions,
      managedTransport: ports.managedTransport,
    });
    await assert.rejects(() =>
      ports.publicationPolicy.run(async (authorization) => {
        await client.createPreparation(preparation, authorization);
        f[invalidate]();
        await client.uploadArtifact("prep-one", descriptor, new Blob([bytes]), authorization);
      }),
    );
    assert.equal(f.counts.captures, 1);
    assert.ok(!f.calls.some((call) => call.path.endsWith("/artifacts")));
    assert.ok(!f.calls.some((call) => call.authorization === "Bearer owned-private-b"));
    assert.equal(f.counts.oauth, 0);
    assert.equal(f.counts.legacy, 0);
  }
});

test("a late successful prepare response cannot survive owner invalidation", async () => {
  const f = fixture(),
    ports = f.createPorts();
  const client = new ConversationShareHttpClient({
    ...f.clientOptions,
    managedTransport: ports.managedTransport,
  });
  f.respond((call) => {
    if (call.path === "/api/client/shares/preparations") {
      f.replaceOwner();
      return Response.json({
        preparation_id: "prep-one",
        access_mode: "organization",
        status: "preparing",
        expires_at: 10,
      });
    }
  });
  await assert.rejects(() =>
    ports.publicationPolicy.run((authorization) =>
      client.createPreparation(preparation, authorization),
    ),
  );
  assert.equal(f.counts.captures, 1);
  assert.equal(f.counts.oauth, 0);
});

test("independent preview validates raw integrity and can_revoke without publisher execute admission", async () => {
  const f = fixture();
  const preview = await f.client.getPreview("share-one");
  assert.equal(preview.share.access_mode, "organization");
  assert.equal(preview.can_revoke, true);
  assert.equal(preview.artifacts.length, 1);
  assert.ok(!f.calls.some((call) => call.path === "/api/client/authorize"));
  assert.equal(f.counts.oauth, 0);
  assert.equal(f.counts.legacy, 0);
});

test("managed readonly continuation and import admission do not run the old continuation", async () => {
  const f = fixture();
  await assert.rejects(
    () => f.client.getContinuation("share-one", continuation),
    (error: unknown) =>
      error instanceof ConversationShareClientError && error.kind === "import_not_allowed",
  );
  await assert.rejects(
    () => f.client.assertImportAllowed("share-one", continuation),
    (error: unknown) =>
      error instanceof ConversationShareClientError && error.kind === "import_not_allowed",
  );
  assert.equal(f.counts.oauth, 0);
  assert.equal(f.counts.legacy, 0);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/continuation")).length, 2);
});

test("managed artifact download consumes finite private JSON and checks actual bytes", async () => {
  const f = fixture();
  const result = await f.client.downloadManagedArtifact(
    `${f.origin}/api/client/shares/share-one/artifacts/artifact-one`,
    descriptor,
  );
  assert.equal(result.managed, true);
  if (result.managed) assert.deepEqual(Buffer.from(result.value.bytes), bytes);
  assert.equal(f.counts.oauth, 0);
  assert.equal(f.counts.legacy, 0);
  f.respond(() =>
    Response.json({ descriptor, content_base64: Buffer.from("tampered").toString("base64") }),
  );
  await assert.rejects(() =>
    f.client.downloadManagedArtifact(
      `${f.origin}/api/client/shares/share-one/artifacts/artifact-one`,
      descriptor,
    ),
  );
});

test("managed share and artifact URLs reject other origins, dot paths and signed URL material", async () => {
  for (const url of [
    "https://other.example.test/cn/share/share-one",
    "https://backend.example.test/cn/share/share-one?token=opaque",
    "https://user@backend.example.test/cn/share/share-one",
  ]) {
    const f = fixture();
    f.respond((call) =>
      call.path.endsWith("/confirm") ? Response.json({ ...f.record, share_url: url }) : undefined,
    );
    const confirmed = buildConversationShareConfirmRequest({
      selected_product_turn_ids: ["turn-one"],
      projection: { rows },
      artifacts: [],
      disclosure_confirmation: {
        version: 1,
        accepted_at: 1,
        acknowledged_no_secret_detection: true,
      },
    });
    await assert.rejects(() => f.client.confirm("prep-one", confirmed));
    assert.equal(f.counts.oauth, 0);
  }
  const f = fixture();
  await assert.rejects(() =>
    f.client.downloadManagedArtifact(
      "https://other.example.test/api/client/shares/share-one/artifacts/artifact-one",
      descriptor,
    ),
  );
  assert.equal(f.calls.length, 0);
});

test("managed backend quota 429 maps to an actionable existing limit error without raw message", async () => {
  const f = fixture();
  f.respond(() =>
    Response.json(
      {
        error: { code: "SHARE_QUOTA", message: "not passed to renderer" },
        requestId: "owned-request",
      },
      { status: 429 },
    ),
  );
  await assert.rejects(
    () => f.client.getCapabilities(),
    (error: unknown) =>
      error instanceof ConversationShareClientError &&
      error.kind === "limit_exceeded" &&
      error.requestId === "owned-request" &&
      !error.message.includes("not passed to renderer"),
  );
});
