import type {
  EnterpriseAdmissionAsset,
  EnterpriseSkillsCatalog,
  ZCodeEnterpriseToolAuthorizationResult,
} from "@zcode/shared";
import type { EnterpriseAssetOperation } from "./contract.js";

/** Private Host projection, never a Renderer identity/credential owner. */
export interface EnterpriseAssetsHost {
  readCatalog(traceId: string, signal?: AbortSignal): Promise<EnterpriseSkillsCatalog>;
  authorizeAsset(
    reference: EnterpriseAdmissionAsset | undefined,
    traceId: string,
    signal?: AbortSignal,
    expectedOwnerKey?: string,
  ): Promise<ZCodeEnterpriseToolAuthorizationResult>;
  clearCached(operation: EnterpriseAssetOperation): Promise<void>;
  disposeAllAndWait(): Promise<void>;
}
