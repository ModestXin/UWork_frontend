import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accessModeToPermission,
  permissionToAccessMode,
  resolveConversationShareAccessMode,
} from "../src/lib/conversationShareAccess.js";

test("organization permission mappings are total and do not fall into private", () => {
  assert.equal(accessModeToPermission("organization"), "organization");
  assert.equal(permissionToAccessMode("organization"), "organization");
  assert.equal(accessModeToPermission("private"), "private");
  assert.equal(accessModeToPermission("public_readonly"), "link-viewer");
  assert.equal(accessModeToPermission("public_importable"), "link-editor");
});

test("capability controls selection; absent capability cannot authorize a default public mode", () => {
  assert.equal(resolveConversationShareAccessMode("public_importable", []), undefined);
  assert.equal(
    resolveConversationShareAccessMode("public_importable", ["organization"]),
    "organization",
  );
  assert.equal(
    resolveConversationShareAccessMode("public_readonly", [
      "private",
      "public_readonly",
      "public_importable",
    ]),
    "public_readonly",
  );
  assert.equal(
    resolveConversationShareAccessMode("organization", ["public_readonly"]),
    "public_readonly",
  );
});
