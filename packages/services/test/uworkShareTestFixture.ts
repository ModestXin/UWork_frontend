import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createUWorkBackendSession } from "../src/enterprise-identity/uworkBackendSession.js";
import type { UWorkBackendSession } from "../src/enterprise-identity/backendSessionContract.js";
import type { EnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";
import { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import * as publication from "../src/conversation-share/uworkPublicationPolicy.js";
import type { ConversationShareManagedTransport } from "../src/conversation-share/uworkPublicationPolicy.js";
import { sha256ConversationShareJson } from "../src/conversation-share/conversationShareIntegrity.js";

export const bytes = Buffer.from("controlled attachment");
export const descriptor = {
  artifact_id: "artifact-one",
  logical_artifact_key: "artifact-one",
  producer_product_turn_id: "turn-one",
  artifact_version: 1,
  state: "current" as const,
  ref: "zcode-artifact://share/artifact-one",
  artifact_type: "text" as const,
  display_name: "controlled.txt",
  extension: "txt",
  mime_type: "text/plain",
  size_bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
export const rows = [
  {
    rowId: 1,
    turnId: "turn-one",
    productTurnId: "turn-one",
    entityId: "input-one",
    kind: "userInput" as const,
    origin: "realUser" as const,
    text: "Controlled content",
    createdAt: 1,
    createdAtSeq: 1,
  },
];
export const capabilities = {
  schema_version: 1,
  access_modes: ["organization"],
  ttl_ms: 604800000,
  max_rows: 2000,
  max_payload_bytes: 1048576,
  max_artifact_count: 8,
  max_artifact_bytes: 524288,
  max_total_artifact_bytes: 1048576,
  allowed_artifacts: [
    { type: "text", extensions: ["txt"], mime_types: ["text/plain"] },
    { type: "md", extensions: ["md"], mime_types: ["text/markdown"] },
    { type: "image", extensions: ["png"], mime_types: ["image/png"] },
    { type: "image", extensions: ["jpg", "jpeg"], mime_types: ["image/jpeg"] },
    { type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] },
  ],
};
export function fixture() {
  const origin = "https://backend.example.test";
  let configuration = { backend: "uwork" as "uwork" | "ucas", apiBaseUrl: origin };
  let controller = new AbortController();
  let authority: EnterpriseIdentityAuthority = {
    generation: 1,
    revision: 1,
    signal: controller.signal,
    session: {
      token: "owned-private-a",
      issuerOrigin: origin,
      expiresAt: Date.now() + 60000,
      profile: {
        id: "member-a",
        tenantId: "tenant-a",
        provider: "wecom",
        displayName: "Synthetic",
      },
    },
  };
  const calls: { path: string; method: string; body: unknown; authorization: string | null }[] = [];
  const counts = { captures: 0, oauth: 0, legacy: 0 };
  const policy = {
    publish: "organization",
    collaborate: "disabled",
    files: true,
    wechat: false,
    wecom: false,
  };
  const security = {
    allowFilesystem: true,
    allowShell: false,
    allowNetwork: false,
    dangerousSkills: false,
    allowedDomains: [],
  };
  const record = {
    access_mode: "organization",
    share_code: "share-one",
    share_url: `${origin}/cn/share/share-one`,
    expires_at: Date.now() + 60000,
  };
  let respond:
    | ((call: (typeof calls)[number]) => Response | Promise<Response> | undefined)
    | undefined;
  const backend = createUWorkBackendSession({
    resolveConfig: async () => configuration,
    readAuthority: () => authority,
    readPersistedSession: async () => ({
      revision: authority.revision,
      session: authority.session,
    }),
    fetchImpl: async (url, init) => {
      assert.equal(init?.redirect, "error");
      const call = {
        path: new URL(String(url)).pathname,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      };
      calls.push(call);
      const controlled = await respond?.(call);
      if (controlled) return controlled;
      if (call.path === "/api/client/authorize")
        return Response.json({
          allowed: policy.publish !== "disabled",
          tenantId: "tenant-a",
          sharing: policy,
          security,
        });
      if (call.path.endsWith("/capabilities")) return Response.json(capabilities);
      if (call.path === "/api/client/shares/preparations")
        return Response.json(
          {
            preparation_id: "prep-one",
            access_mode: "organization",
            status: "preparing",
            expires_at: record.expires_at,
          },
          { status: 201 },
        );
      if (call.path.endsWith("/confirm")) return Response.json(record);
      if (call.path.endsWith("/preview"))
        return Response.json({
          schema_version: 1,
          share: {
            title: "Controlled",
            access_mode: "organization",
            created_at: 1,
            expires_at: record.expires_at,
          },
          rows,
          artifacts: [
            {
              ...descriptor,
              url: `${origin}/api/client/shares/share-one/artifacts/artifact-one`,
              url_expires_at: record.expires_at,
            },
          ],
          can_revoke: true,
          integrity: {
            projection_sha256: sha256ConversationShareJson(rows),
            artifact_set_sha256: sha256ConversationShareJson([descriptor]),
          },
        });
      if (call.path.endsWith("/continuation"))
        return Response.json(
          { error: { code: "SHARE_READONLY", message: "readonly" } },
          { status: 403 },
        );
      if (call.method === "GET" && call.path.endsWith("/artifacts/artifact-one"))
        return Response.json({ descriptor, content_base64: bytes.toString("base64") });
      if (call.method === "POST" && call.path.endsWith("/artifacts")) {
        const uploaded = (call.body as { descriptor: typeof descriptor }).descriptor;
        return Response.json(
          {
            artifact_id: uploaded.artifact_id,
            size_bytes: uploaded.size_bytes,
            sha256: uploaded.sha256,
            status: "uploaded",
            safety_status: "opaque",
          },
          { status: 201 },
        );
      }
      return Response.json(
        { error: { code: "NOT_FOUND", message: "unavailable" } },
        { status: 404 },
      );
    },
  });
  const counted: UWorkBackendSession = {
    async run(operation, options) {
      counts.captures++;
      return backend.run(operation, options);
    },
  };
  // 这个入口使旧 Source 能到达真实旧 HttpClient 行为 RED，而非仅因新 factory 缺失无法加载。
  const transport: ConversationShareManagedTransport = {
    run: (operation, options) => counted.run(operation, options),
  };
  const clientOptions = {
    baseUrl: "https://legacy-share.example.test/api/v1",
    managedTransport: transport,
    tokenProvider: async () => {
      counts.oauth++;
      return "legacy-private";
    },
    apiClient: {
      async request() {
        counts.legacy++;
        return Response.json({
          code: 0,
          msg: "ok",
          data: {
            ...capabilities,
            access_modes: ["private", "public_readonly", "public_importable"],
          },
        });
      },
    },
  };
  const client = new ConversationShareHttpClient(clientOptions);
  return {
    origin,
    backend: counted,
    client,
    clientOptions,
    counts,
    calls,
    policy,
    security,
    record,
    respond(value: typeof respond) {
      respond = value;
    },
    unmanaged() {
      configuration = { backend: "ucas", apiBaseUrl: origin };
    },
    changeIssuer() {
      configuration = { backend: "uwork", apiBaseUrl: "https://other.example.test" };
    },
    logout() {
      controller.abort();
      authority = { ...authority, generation: 2, revision: 2, session: null };
    },
    replaceOwner() {
      controller.abort();
      controller = new AbortController();
      authority = {
        generation: 2,
        revision: 2,
        signal: controller.signal,
        session: {
          token: "owned-private-b",
          issuerOrigin: origin,
          expiresAt: Date.now() + 60000,
          profile: {
            id: "member-b",
            tenantId: "tenant-b",
            provider: "wecom",
            displayName: "Synthetic B",
          },
        },
      };
    },
    createPorts() {
      return publication.createUWorkSharePorts(counted);
    },
  };
}
