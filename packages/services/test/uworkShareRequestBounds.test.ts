import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./uworkShareTestFixture.js";

test("the existing private port admits only exact finite share methods and paths", async () => {
  for (const [path, method] of [
    ["/api/client/shares/capabilities", "POST"],
    ["/api/client/shares/preparations", "GET"],
    ["/api/client/shares/preparations/../confirm", "POST"],
    ["/api/client/shares/preparations/%2e%2e/confirm", "POST"],
    ["/api/client/shares/share-one/artifacts/artifact-one/content", "GET"],
    ["/api/client/shares/share-one/artifacts/artifact-one?url=https://external.invalid", "GET"],
    ["https://external.invalid/api/client/shares/capabilities", "GET"],
  ] as const) {
    const f = fixture();
    await assert.rejects(() =>
      f.backend.run((scope) => scope.request(path, undefined, { method })),
    );
    assert.equal(f.calls.length, 0);
  }
});

test("only confirm gets 1MiB; the ordinary 64KiB body and GET no-body limits remain", async () => {
  const f = fixture();
  await f.backend.run((scope) =>
    scope.request("/api/client/shares/preparations/prep-one/confirm", {
      controlled: "a".repeat(70000),
    }),
  );
  const afterConfirm = f.calls.length;
  await assert.rejects(() =>
    f.backend.run((scope) =>
      scope.request("/api/client/authorize", { controlled: "a".repeat(70000) }),
    ),
  );
  await assert.rejects(() =>
    f.backend.run((scope) =>
      scope.request("/api/client/shares/capabilities", {}, { method: "GET" }),
    ),
  );
  await assert.rejects(() =>
    f.backend.run((scope) =>
      scope.request("/api/client/shares/preparations/prep-one/confirm", {
        controlled: "a".repeat(1048576),
      }),
    ),
  );
  assert.equal(f.calls.length, afterConfirm);
});

test("share JSON response size remains bounded before consuming body data", async () => {
  const f = fixture();
  f.respond(() => Response.json({ controlled: "a".repeat(1048576 + 65536) }));
  await assert.rejects(
    () => f.backend.run((scope) => scope.request("/api/client/shares/share-one/preview")),
    /enterprise_response_limit/,
  );
});
