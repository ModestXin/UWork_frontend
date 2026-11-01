import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import { ConversationShareService } from "../src/conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "../src/conversation-share/conversationShareArtifactSource.js";
import {
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatResultSchema,
  type ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import { extractConversationPreviewFileReferences } from "@zcode/shared";
import { fixture, rows } from "./uworkShareTestFixture.js";

async function localFixture(t: TestContext, extension = "pdf") {
  const root = await mkdtemp(join(tmpdir(), "owned-share-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, `controlled.${extension}`);
  const content = Buffer.from("owned opaque attachment bytes");
  await writeFile(filePath, content);
  const inputImage = ["png", "jpg", "jpeg"].includes(extension);
  const f = fixture(),
    ports = f.createPorts(),
    source = createLocalConversationShareArtifactSource();
  const io = { stat: 0, read: 0 };
  let afterRead: (() => void) | undefined;
  const conversation: ConversationRow[] = [
    {
      rowId: 1,
      turnId: "turn-one",
      productTurnId: "turn-one",
      entityId: "header-one",
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
      endedAt: 2,
      createdAt: 1,
      createdAtSeq: 1,
    },
    {
      ...rows[0]!,
      rowId: 2,
      createdAtSeq: 2,
      ...(inputImage
        ? {
            attachments: [
              {
                ref: "owned-input-image",
                fileName: `controlled.${extension}`,
                mime: extension === "png" ? "image/png" : "image/jpeg",
                bytes: content.byteLength,
              },
            ],
          }
        : {}),
    },
    {
      rowId: 3,
      turnId: "turn-one",
      productTurnId: "turn-one",
      entityId: "assistant-one",
      kind: "assistantText",
      text: inputImage
        ? "Controlled result with selected input image"
        : `Controlled result [attachment](controlled.${extension})`,
      state: "complete",
      createdAt: 1,
      createdAtSeq: 3,
    },
  ];
  if (!inputImage)
    assert.equal(
      extractConversationPreviewFileReferences(
        `Controlled result [attachment](controlled.${extension})`,
        root,
      ).length,
      1,
      "fixture must select an existing preview-file path",
    );
  const client = new ConversationShareHttpClient({
    ...f.clientOptions,
    managedTransport: ports.managedTransport,
  });
  const service = new ConversationShareService({
    client,
    publicationPolicy: ports.publicationPolicy,
    conversationWorkspaceRoot: root,
    artifactSource: {
      async stat(input) {
        io.stat++;
        return source.stat!(input);
      },
      async read(input) {
        io.read++;
        const value = await source.read(input);
        afterRead?.();
        return value;
      },
    },
    zcodeAgentService: {
      conversationRowsRangeV4: async () => ({
        rows: conversation,
        hasMore: false,
        atSeq: 3,
        atRevision: 1,
        atLogEpoch: "owned-epoch",
      }),
      conversationFileChangesV4: async () => {
        throw new Error("No markdown/html file changes expected");
      },
      conversationAttachmentReadV4: async () => {
        assert.ok(inputImage);
        io.read++;
        const data = await readFile(filePath);
        afterRead?.();
        return v4ConversationAttachmentReadResultSchema.parse({
          dataBase64: data.toString("base64"),
          mediaType: extension === "png" ? "image/png" : "image/jpeg",
          totalBytes: data.byteLength,
          nextOffset: null,
        });
      },
      conversationAttachmentStatV4: async () => {
        assert.ok(inputImage);
        io.stat++;
        const metadata = await stat(filePath);
        return v4ConversationAttachmentStatResultSchema.parse({
          mediaType: extension === "png" ? "image/png" : "image/jpeg",
          totalBytes: metadata.size,
          mtimeMs: metadata.mtimeMs,
        });
      },
    },
  });
  const input = {
    workspacePath: root,
    sessionId: "session-one",
    selection: { kind: "productTurns" as const, productTurnIds: ["turn-one"] },
  };
  return {
    ...f,
    service,
    input,
    io,
    afterRead(callback: () => void) {
      afterRead = callback;
    },
    publish: () =>
      service.publish(
        {
          ...input,
          title: "Controlled",
          accessMode: "organization",
          clientRequestId: "intent-one",
          disclosureAcceptedAt: 1,
        },
        "operation-one",
      ),
  };
}

test("managed files/FS denial retains text and explicit omitted-file warning without any path stat/read", async (t) => {
  for (const setting of ["files", "filesystem"] as const) {
    const f = await localFixture(t);
    if (setting === "files") f.policy.files = false;
    else f.security.allowFilesystem = false;
    const preflight = await f.service.preflight(f.input);
    assert.deepEqual(preflight.accessModes, ["organization"]);
    assert.ok(
      preflight.skippableWarnings.some((issue) => issue.code === "artifact_type_not_allowed"),
    );
    await f.publish();
    assert.deepEqual(f.io, { stat: 0, read: 0 });
    const request = f.calls.find((call) => call.path === "/api/client/shares/preparations");
    assert.equal((request?.body as { artifact_count?: number })?.artifact_count, 0);
    assert.ok(!f.calls.some((call) => call.path.endsWith("/artifacts")));
  }
});

test("logout after actual owned file read prevents the returned bytes from upload or confirm", async (t) => {
  const f = await localFixture(t);
  f.afterRead(() => f.logout());
  await assert.rejects(() => f.publish());
  assert.equal(f.io.read, 1);
  assert.ok(
    !f.calls.some(
      (call) =>
        call.path === "/api/client/shares/preparations" ||
        call.path.endsWith("/artifacts") ||
        call.path.endsWith("/confirm"),
    ),
  );
  assert.equal(f.counts.oauth, 0);
  assert.equal(f.counts.legacy, 0);
});

test("JPEG uses its own capability combination even when the first image entry is PNG", async (t) => {
  const f = await localFixture(t, "jpeg");
  const preflight = await f.service.preflight(f.input);
  assert.ok(
    !preflight.skippableWarnings.some((issue) => issue.code === "artifact_type_not_allowed"),
  );
  await f.publish();
  assert.ok(f.io.read > 0);
  const body = f.calls.find((call) => call.path.endsWith("/artifacts"))?.body as
    | { descriptor?: { extension?: string; mime_type?: string } }
    | undefined;
  assert.equal(body?.descriptor?.extension, "jpeg");
  assert.equal(body?.descriptor?.mime_type, "image/jpeg");
});

test("local filesystem permission revoked after actual read rejects bytes before upload", async (t) => {
  const f = await localFixture(t);
  f.afterRead(() => {
    f.security.allowFilesystem = false;
  });
  await assert.rejects(() => f.publish());
  assert.equal(f.io.read, 1);
  assert.ok(
    !f.calls.some((call) => call.path.endsWith("/artifacts") || call.path.endsWith("/confirm")),
  );
});
