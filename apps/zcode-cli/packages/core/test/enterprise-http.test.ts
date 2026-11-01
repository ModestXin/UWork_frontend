import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRootTraceContext,
  type HttpClientPort,
  type SessionId,
  type TraceId,
} from "@zcode/contracts";
import { withEnterpriseHttpAuthorization } from "../../adapters/src/http/enterprise-http.js";
import { fetchAndExtractContent } from "../src/tool/handlers/webfetch-network.js";

const context = {
  sessionId: "controlled",
  workspacePath: "/controlled",
  workingDirectory: "/controlled",
  traceContext: createRootTraceContext(),
};

test("actual WebFetch redirect handling authorizes each target before network dispatch", async () => {
  const urls: string[] = [],
    admissions: string[] = [];
  const raw: HttpClientPort = {
    async request(request) {
      urls.push(request.url);
      assert.equal(request.redirect, "manual");
      assert.equal(request.egressPolicy, "public");
      return {
        url: request.url,
        status: 302,
        statusText: "Found",
        headers: { location: "https://www.example.test/final" },
        body: new Uint8Array(),
        bytes: 0,
        durationMs: 0,
      };
    },
  };
  const guarded = withEnterpriseHttpAuthorization(raw, {
    ...context,
    authorization: {
      async authorize(request) {
        assert.equal(request.phase, "network_request");
        assert.equal(request.capability.networkGuarded, true);
        const url = (request.input as { url: string }).url;
        admissions.push(url);
        const allowed = new URL(url).hostname === "example.test";
        return { allowed, code: allowed ? "allowed" : "enterprise_domain_denied" };
      },
    },
  });
  await assert.rejects(
    () =>
      fetchAndExtractContent({
        originalUrl: "https://example.test/start",
        url: new URL("https://example.test/start"),
        context: {
          toolCallId: "controlled-call",
          traceId: context.traceContext.traceId as TraceId,
          abortSignal: new AbortController().signal,
          workingDirectory: "/controlled",
          workspaceRoot: "/controlled",
          sessionId: "controlled" as SessionId,
          httpClientPort: guarded,
        },
      }),
    /enterprise_domain_denied/,
  );
  assert.deepEqual(admissions, ["https://example.test/start", "https://www.example.test/final"]);
  assert.deepEqual(urls, ["https://example.test/start"]);
});

test("network admission rejects automatic redirects and never sends headers or body to Host", async () => {
  let runs = 0,
    checks = 0;
  const guarded = withEnterpriseHttpAuthorization(
    {
      async request() {
        runs++;
        throw new Error("must not run");
      },
    },
    {
      ...context,
      authorization: {
        async authorize(request) {
          checks++;
          assert.deepEqual(request.input, { url: "https://example.test/" });
          return checks === 1
            ? { allowed: true, code: "allowed" }
            : { allowed: false, code: "enterprise_network_denied" };
        },
      },
    },
  );
  await assert.rejects(
    () => guarded.request({ url: "https://example.test/", redirect: "follow" }),
    /enterprise_redirect_unsupported/,
  );
  await assert.rejects(
    () =>
      guarded.request({
        url: "https://example.test/",
        headers: { authorization: "synthetic-private" },
        body: new TextEncoder().encode("synthetic-private"),
      }),
    /enterprise_network_denied/,
  );
  assert.deepEqual({ runs, checks }, { runs: 0, checks: 2 });
});

test("parent cancellation during network admission prevents late dispatch", async () => {
  const parent = new AbortController();
  let runs = 0;
  const guarded = withEnterpriseHttpAuthorization(
    {
      async request() {
        runs++;
        throw new Error("must not run");
      },
    },
    {
      ...context,
      authorization: {
        async authorize() {
          parent.abort();
          return { allowed: true, code: "allowed" };
        },
      },
    },
  );
  await assert.rejects(
    () => guarded.request({ url: "https://example.test/" }, { signal: parent.signal }),
    /enterprise_authorization_cancelled/,
  );
  assert.equal(runs, 0);
});

test("trusted unmanaged profiles retain existing redirect and egress behavior", async () => {
  const requests: unknown[] = [];
  const raw: HttpClientPort = {
    async request(request) {
      requests.push(request);
      return {
        url: request.url,
        status: 200,
        statusText: "OK",
        headers: {},
        body: new Uint8Array(),
        bytes: 0,
        durationMs: 0,
      };
    },
  };
  const guarded = withEnterpriseHttpAuthorization(raw, {
    ...context,
    authorization: {
      async authorize() {
        return { allowed: true, code: "not_managed" };
      },
    },
  });
  await guarded.request({ url: "http://127.0.0.1/", redirect: "follow" });
  assert.deepEqual(requests, [
    { url: "http://127.0.0.1/", redirect: "follow", headers: undefined, body: undefined },
  ]);
});
