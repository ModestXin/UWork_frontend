import {
  EnterpriseAssetStoreError,
  type EnterpriseAssetOperation,
  type EnterpriseAssetStore,
} from "./contract.js";

/** Consumers must obtain current backend authorization separately before using this directory. */
export async function readVerifiedSkillDirectory(
  store: EnterpriseAssetStore,
  key: string,
  operation: EnterpriseAssetOperation,
): Promise<string> {
  const reference = await store.verify(key, operation);
  if (reference.asset.kind !== "skill")
    throw new EnterpriseAssetStoreError("enterprise_asset_kind_unsupported");
  return reference.directory;
}
