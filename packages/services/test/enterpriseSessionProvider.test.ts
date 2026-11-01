import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderConfigMap, ApiKeyAccessConfig, ProviderConfig } from "@zcode/provider";

test("enterprise session access is complete without a key and never accepts credentials", () => {
  const parse = (access: unknown) =>
    parseProviderConfigMap([
      {
        providerId: "managed",
        config: {
          group: "standard-personal",
          access,
          api: { type: "openai-chat-completions", baseUrl: "https://backend.example.test/v1" },
        },
      },
    ]).get("managed")!;
  const config = parse({ type: "enterprise-session" });
  assert.deepEqual(config.access?.toJSON(), { type: "enterprise-session" });
  assert.equal(config.validateComplete().length, 0);
  const old = new ProviderConfig({
    access: new ApiKeyAccessConfig({ apiKey: "synthetic-retired-device" }),
  });
  const migrated = old.overlay(config);
  assert.equal(JSON.stringify(migrated.toJSON()).includes("synthetic-retired-device"), false);
  for (const field of ["apiKey", "token", "headers"])
    assert.throws(() => parse({ type: "enterprise-session", [field]: "must-not-be-accepted" }));
});
