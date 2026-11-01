import type {
  EnterpriseSkillsCatalogPort,
  EnterpriseSkillsCatalogRequest,
} from "./enterprise-skills-catalog.port.js";

/** The caller still needs current before/after-load admission before returning any body. */
export async function currentEnterpriseSkillReferences(
  port: EnterpriseSkillsCatalogPort,
  request: EnterpriseSkillsCatalogRequest,
  signal?: AbortSignal,
) {
  const catalog = await port.readCatalog(request, signal);
  return catalog.status === "ready" && catalog.allowFilesystem ? catalog.assets : [];
}
