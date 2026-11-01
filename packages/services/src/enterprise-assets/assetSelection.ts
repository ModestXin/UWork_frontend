import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  assertCurrent,
  EnterpriseAssetStoreError,
  type EnterpriseAssetOperation,
} from "./assetPackage.js";
import { assertDirectory, assertRootPath, hasCode, readBoundedFile } from "./assetStoreFs.js";

export const SELECTION_FILE = ".selection.json";
const ownerSchema = z
  .object({ format: z.literal("uwork.enterprise-assets/v1"), owner: z.uuid() })
  .strict();
const selectionSchema = z
  .object({
    format: z.literal("uwork.enterprise-selection/v1"),
    owner: z.uuid(),
    revision: z.uuid(),
  })
  .strict();

export async function readSelection(root: string, owner: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(join(root, SELECTION_FILE), 4096);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  const record = selectionSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (record.owner !== owner) throw new EnterpriseAssetStoreError("enterprise_asset_owner_changed");
  return record.revision;
}

/** Caller holds the cache mutation lock. Revision publication precedes every destructive prune. */
export async function advanceSelection(
  root: string,
  owner: string,
  operation: EnterpriseAssetOperation,
): Promise<string> {
  const revision = randomUUID(),
    stage = join(root, `stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  const created = await lstat(stage);
  let outcome: { success: true } | { success: false; error: unknown };
  try {
    await writeFile(
      join(stage, ".ownership.json"),
      JSON.stringify({ format: "uwork.enterprise-assets/v1", owner }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(stage, SELECTION_FILE),
      JSON.stringify({ format: "uwork.enterprise-selection/v1", owner, revision }),
      { flag: "wx", mode: 0o600 },
    );
    await assertRootPath(root);
    assertCurrent(operation);
    await rename(join(stage, SELECTION_FILE), join(root, SELECTION_FILE));
    outcome = { success: true };
  } catch (error) {
    outcome = { success: false, error };
  }
  try {
    await assertRootPath(root);
    const remaining = await assertDirectory(stage);
    if (remaining.ino !== created.ino || remaining.dev !== created.dev)
      throw new EnterpriseAssetStoreError("enterprise_asset_owner_changed");
    const currentOwner = ownerSchema.parse(
      JSON.parse((await readBoundedFile(join(root, ".owner.json"), 4096)).toString("utf8")),
    );
    if (currentOwner.owner !== owner)
      throw new EnterpriseAssetStoreError("enterprise_asset_owner_changed");
    await rm(stage, { recursive: true });
  } catch (error) {
    if (!outcome.success)
      throw new EnterpriseAssetStoreError("enterprise_asset_cleanup_unconfirmed");
    throw error;
  }
  if (!outcome.success) throw outcome.error;
  return revision;
}
