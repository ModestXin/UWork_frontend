import { useEnterpriseIdentityStore } from "@/store/enterpriseIdentityStore.js";
import { useEnterpriseIdentity } from "./useEnterpriseIdentity.js";
import { clientExperienceScopeKey } from "./clientExperienceScope.js";

export function useClientExperienceScope(kind: "scenes" | "pluginStore"): string {
  const owner = useEnterpriseIdentityStore((state) => state.owner);
  const view = useEnterpriseIdentityStore((state) => state.view);
  const identity = useEnterpriseIdentity();
  return clientExperienceScopeKey(owner, view, identity?.presentation ?? null, kind);
}
