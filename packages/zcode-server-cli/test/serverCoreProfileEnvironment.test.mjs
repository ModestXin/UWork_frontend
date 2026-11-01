import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveServerLayout } from "../src/runtime/paths.ts";
import { createServerCoreProfileEnvironment } from "../src/runtime/serverCoreProfileEnvironment.ts";

test("standard Server root retains its original home and factory leaves the caller environment intact", () => {
  const before = { ...process.env };
  const home = join(process.cwd(), "owned-profile");
  const root = join(home, ".zcode", "server");
  assert.deepEqual(createServerCoreProfileEnvironment(resolveServerLayout(root)), {
    HOME: home,
    USERPROFILE: home,
    ZCODE_DESKTOP_HOME_DIR: home,
    UWORK_DATA_BASE_DIR: home,
    ZCODE_DATA_BASE_DIR: home,
    ZCODE_STORAGE_DIR: join(home, ".uwork"),
    ZCODE_SERVER_ROOT: root,
  });
  assert.deepEqual({ ...process.env }, before);
});
