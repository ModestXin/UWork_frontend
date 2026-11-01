import type { ZCodePluginReferenceCatalogEntry } from "@zcode/shared";

export type InstalledSuggestedPluginEntry = Pick<
  ZCodePluginReferenceCatalogEntry,
  "pluginId" | "name" | "enabled" | "conflictingPluginIds"
>;

/** A published string is metadata, never an installation instruction or marketplace address. */
export function matchPublishedInstalledPlugin(
  stableId: string,
  entries: readonly InstalledSuggestedPluginEntry[],
) {
  const matches = entries.filter((entry) => entry.pluginId === stableId);
  const entry = matches.length === 1 ? matches[0] : undefined;
  return entry?.enabled && entry.conflictingPluginIds.length === 0
    ? {
        stableId: entry.pluginId,
        label: { cn: entry.name, en: entry.name },
        installedOnly: true as const,
      }
    : undefined;
}

/** Click-time revalidation only reads the existing installed catalog; it has no install capability. */
export async function revalidatePublishedInstalledPlugin(
  stableId: string,
  readCatalog: () => Promise<readonly InstalledSuggestedPluginEntry[]>,
) {
  try {
    return matchPublishedInstalledPlugin(stableId, await readCatalog());
  } catch {
    return undefined;
  }
}
