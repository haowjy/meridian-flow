/**
 * Where an import shows in the tree: the areas and folders it opens when it
 * starts.
 */
import { t } from "@lingui/core/macro";
import type { ImportScheme, ImportSummary } from "@meridian/contracts";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ImportDestination, isImportScheme } from "./destination";
import { fullyRead, type ImportState } from "./import-state";
import { catalogPathOfUri } from "./tree-projection";

export type Placement = { scheme: ImportScheme; path: string; folderId: string | null };

/** The folder an import was started on, from the server's summary alone. */
export function destinationFromSummary(summary: ImportSummary): ImportDestination {
  const uri = summary.destination.folderUri;
  const scheme = (uri.match(/^([a-z]+):\/\//)?.[1] ?? "kb") as ImportDestination["scheme"];
  const path = catalogPathOfUri(uri) ?? "/";
  return {
    scheme,
    path,
    uri,
    name: path === "/" ? areaLabel(scheme) : path.slice(path.lastIndexOf("/") + 1),
    folderId: summary.destination.folderId,
  };
}

function areaLabel(scheme: ImportDestination["scheme"]): string {
  return scheme === "manuscript"
    ? t`Manuscript`
    : scheme === "unfiled"
      ? t`Unfiled`
      : t`Knowledge Base`;
}

export function placementsOf(state: ImportState): Placement[] {
  const local = state.local;
  if (local) {
    const areas = new Set(local.rows.map((row) => row.scheme));
    // A Meridian export's rows go to several areas at once; each opens.
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
  if (fullyRead(report) && report.roots.length === 1 && report.roots[0].id === null) {
    const areas = new Set<ImportScheme>();
    for (const entry of report.entries.values()) {
      const scheme = entry.uri?.match(/^([a-z]+):\/\//)?.[1];
      if (scheme && isImportScheme(scheme as ProjectContextTreeScheme))
        areas.add(scheme as ImportScheme);
    }
    if (areas.size > 0) return [...areas].map((scheme) => ({ scheme, path: "/", folderId: null }));
  }
  if (!state.report) return [];
  const destination = destinationFromSummary(state.report.summary);
  if (!isImportScheme(destination.scheme)) return [];
  return [{ scheme: destination.scheme, path: destination.path, folderId: destination.folderId }];
}
