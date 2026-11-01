import type { EnterpriseAssetOperation, EnterpriseAssetReference } from "./assetPackage.js";
export type {
  EnterpriseAssetBinding,
  EnterpriseAssetOperation,
  EnterpriseAssetReference,
} from "./assetPackage.js";
export { EnterpriseAssetStoreError } from "./assetPackage.js";
export interface EnterpriseAssetStoreEvent {
  event: "enterprise.asset.cache";
  traceId: string;
  operation: "materialize" | "verify" | "prune" | "revision" | "select";
  status: "succeeded" | "failed";
  durationMs: number;
  code?: string;
}

/** Host-private derived cache. A verified reference is never an execution authorization. */
export interface EnterpriseAssetStore {
  readSelectionRevision(operation: EnterpriseAssetOperation): Promise<string | null>;
  select(
    expectedRevision: string | null,
    keepKeys: readonly string[],
    operation: EnterpriseAssetOperation,
  ): Promise<string>;
  materialize(
    download: unknown,
    operation: EnterpriseAssetOperation,
  ): Promise<EnterpriseAssetReference>;
  verify(key: string, operation: EnterpriseAssetOperation): Promise<EnterpriseAssetReference>;
  prune(keepKeys: readonly string[], operation: EnterpriseAssetOperation): Promise<void>;
}
