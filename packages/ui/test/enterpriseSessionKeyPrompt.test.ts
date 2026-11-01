import assert from "node:assert/strict";
import test from "node:test";
import { shouldRequestUcasApiKey } from "../src/login/ucasApiKeyPrompt.js";
import type { ProviderSettingsView } from "@zcode/provider";

test("enterprise session login never asks for a model key, including failed synchronization", () => {
  const view = (access: unknown) =>
    ({
      providers: [{ providerId: "ucas", personalConfig: { access } }],
    }) as unknown as ProviderSettingsView;
  assert.equal(shouldRequestUcasApiKey(view({ type: "enterprise-session" })), false);
  assert.equal(shouldRequestUcasApiKey(view({ type: "api-key" }), "enterprise-session"), false);
  assert.equal(
    shouldRequestUcasApiKey(view({ type: "api-key", apiKey: "synthetic-existing" })),
    false,
  );
  assert.equal(shouldRequestUcasApiKey(view({ type: "api-key", apiKey: "  " })), true);
});
