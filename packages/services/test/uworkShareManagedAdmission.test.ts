import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationShareAccessModeSchema } from "@zcode/shared";
import { fixture } from "./uworkShareTestFixture.js";

test("organization is a distinct readonly mode, never a legacy private/public fallback", () => {
  assert.equal(conversationShareAccessModeSchema.parse("organization"), "organization");
});

test("managed capabilities enter the actual private BackendSession before any legacy OAuth/API", async () => {
  const f = fixture();
  assert.deepEqual((await f.client.getCapabilities()).access_modes, ["organization"]);
  assert.equal(f.counts.oauth, 0);
  assert.equal(f.counts.legacy, 0);
  assert.equal(f.calls[0]?.path, "/api/client/shares/capabilities");
  assert.equal(f.calls[0]?.authorization, "Bearer owned-private-a");
});

test("managed failures and malformed capabilities never fall back to OAuth or public modes", async () => {
  for (const response of [
    Response.json({ error: { code: "SESSION_EXPIRED", message: "safe" } }, { status: 401 }),
    Response.json({ access_modes: ["private"] }),
  ]) {
    const f = fixture();
    f.respond(() => response);
    await assert.rejects(() => f.client.getCapabilities());
    assert.equal(f.counts.oauth, 0);
    assert.equal(f.counts.legacy, 0);
  }
});

test("unmanaged capability discovery keeps the existing OAuth/API path", async () => {
  const f = fixture();
  f.unmanaged();
  assert.deepEqual((await f.client.getCapabilities()).access_modes, [
    "private",
    "public_readonly",
    "public_importable",
  ]);
  assert.equal(f.counts.oauth, 1);
  assert.equal(f.counts.legacy, 1);
  assert.equal(f.calls.length, 0);
});
