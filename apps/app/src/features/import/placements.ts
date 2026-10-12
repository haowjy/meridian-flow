/** Where an import's status row sits: the destination folder, or each area a Meridian export fills. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { type ImportScheme, isImportScheme } from "./destination";
import type { ImportState } from "./import-state";
import { catalogPathOfUri } from "./tree-projection";

export type Placement = { scheme: ImportScheme; path: string; folderId: string | null };

export function placementsOf(state: ImportState): Placement[] {
  const local = state.local;
  if (local) {
    const areas = new Set(local.rows.map((row) => row.scheme));
    // A Meridian export's rows go to several areas at once; each gets a status row.
    if (areas.size > 1 || (areas.size === 1 && !areas.has(local.destination.scheme)))
      return [...areas].map((scheme) => ({ scheme, path: "/", folderId: null }));
    return [
      {
        scheme: local.destination.scheme,
        path: local.destination.path,
        folderId: local.destination.folderId,
      },
    ];
  }
  // A Meridian export fills its own areas wherever it was started; once the report is
  // loaded, its entries say which ones.
  const report = state.report;
  if (report?.complete && report.roots.length === 1 && report.roots[0].id === null) {
    const areas = new Set<ImportScheme>();
    for (const entry of report.entries.values()) {
      const scheme = entry.uri?.match(/^([a-z]+):\/\//)?.[1];
      if (scheme && isImportScheme(scheme as ProjectContextTreeScheme))
        areas.add(scheme as ImportScheme);
    }
    if (areas.size > 0) return [...areas].map((scheme) => ({ scheme, path: "/", folderId: null }));
  }
  const uri = state.report?.summary.destination.folderUri;
  const scheme = uri?.match(/^([a-z]+):\/\//)?.[1];
  if (!uri || !scheme || !isImportScheme(scheme as ProjectContextTreeScheme)) return [];
  return [{ scheme: scheme as ImportScheme, path: catalogPathOfUri(uri) ?? "/", folderId: null }];
}

/**
 * The tree folder (by catalog id) each import's status row belongs under in this
 * scheme: the folder it was invoked on, followed by id when this tab started it
 * and by path otherwise, falling back to the area root when it is gone.
 */
export function statusParents(
  catalog: CatalogContextView,
  scheme: ProjectContextTreeScheme,
  states: readonly ImportState[],
): Map<string, string[]> {
  const byParent = new Map<string, string[]>();
  for (const state of states) {
    if (state.dismissing || state.report?.summary.dismissedAt) continue;
    for (const placement of placementsOf(state)) {
      if (placement.scheme !== scheme) continue;
      let parentId = catalog.root.entryId;
      if (placement.path !== "/") {
        const byId = placement.folderId
          ? catalog.normalized.entries.get(placement.folderId)
          : undefined;
        if (byId?.kind === "folder") parentId = placement.folderId as string;
        else {
          const found = catalog.findPath(placement.path);
          if (found?.kind === "dir") parentId = found.entryId;
        }
      }
      byParent.set(parentId, [...(byParent.get(parentId) ?? []), state.importId]);
    }
  }
  return byParent;
}
