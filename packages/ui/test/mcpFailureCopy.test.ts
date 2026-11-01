import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMcpFailureMessageId } from "../src/settings/mcpFailureCopy.js";

test("an exact enterprise connector denial explains policy instead of suggesting network repair", () => {
  for (const code of [
    "enterprise_personal_connectors_denied",
    "enterprise_shell_denied",
    "enterprise_filesystem_denied",
    "enterprise_network_denied",
    "enterprise_domain_denied",
  ])
    assert.equal(
      resolveMcpFailureMessageId("connection_failed", code),
      "settings.mcp.failure.enterprisePolicyDenied",
    );
});

test("an obsolete enterprise runtime has a refresh action", () => {
  assert.equal(
    resolveMcpFailureMessageId(undefined, "enterprise_runtime_obsolete"),
    "settings.mcp.failure.enterpriseRuntimeChanged",
  );
});

test("unavailable enterprise policy has a separate diagnostic", () => {
  assert.equal(
    resolveMcpFailureMessageId(undefined, "enterprise_policy_unavailable"),
    "settings.mcp.failure.enterprisePolicyUnavailable",
  );
});

test("ordinary failures and supplier prose keep the existing category", () => {
  assert.equal(resolveMcpFailureMessageId(undefined), "settings.mcp.failure.connection_failed");
  assert.equal(
    resolveMcpFailureMessageId(
      "connection_failed",
      "provider text mentions enterprise_runtime_obsolete",
    ),
    "settings.mcp.failure.connection_failed",
  );
});
