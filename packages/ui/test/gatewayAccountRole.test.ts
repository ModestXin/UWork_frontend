import assert from "node:assert/strict";
import test from "node:test";
import { gatewayAccountRoleId } from "../src/settings/ucas-gateway/gatewayFormat.js";

test("gateway account role preserves every managed role and legacy labels", () => {
  for (const role of [
    "owner",
    "admin",
    "operator",
    "auditor",
    "member",
    "super_admin",
    "org_admin",
    "user",
  ])
    assert.equal(gatewayAccountRoleId(role), role);
  assert.equal(gatewayAccountRoleId("unknown-from-server"), "user");
  assert.equal(gatewayAccountRoleId("__proto__"), "user");
});
