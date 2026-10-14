/**
 * Where an import shows in the tree, and where its own status marks go: the areas
 * it fills, the folder it was started on, the new top-level folders (the row the
 * progress ring sits on) and the destination or area headers that carry a mark
 * when no predicted root row can. One contract for the tree, the phone listing and
 * the progress panel.
 */
import { t } from "@lingui/core/macro";
import type { ImportScheme, ImportSummary } from "@meridian/contracts";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ImportDestination } from "./destination";
import { fullyRead, type ImportState } from "./import-state";

/** An area, or a folder in it (null: the area's own root header). */
export type MarkAnchor = { scheme: ImportScheme; folderId: string | null };

export type ImportTarget = {
  /** The areas the import fills; several for a routed Meridian export. */
  schemes: readonly ImportScheme[];
  /** The folder it was started on; null for a routed export, which fills its own areas. */
  destination: { scheme: ImportScheme; path: string; folderId: string | null } | null;
  /** Ids of the new top-level folders, known from the pick. */
  rootIds: readonly string[];
  /**
   * Where the run's mark sits when a root row cannot carry it (none was predicted, or
   * the picked root is a file): the destination folder, or each routed area's header.
   */
  anchors: readonly MarkAnchor[];
};

function anchorsOf(
  destination: ImportTarget["destination"],
  schemes: readonly ImportScheme[],
): MarkAnchor[] {
  return destination
    ? [{ scheme: destination.scheme, folderId: destination.folderId }]
    : schemes.map((scheme) => ({ scheme, folderId: null }));
}

/** The catalog path ("/Lore/Sects") of a context URI, or null when it is not one. */
export function catalogPathOfUri(uri: string | null): string | null {
  if (!uri) return null;
  const parsed = parseContextUri(uri);
  return parsed.ok ? `/${parsed.value.path}` : null;
}

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

/** The target of one import: from the run's predicted rows, else from its status. */
export function targetOf(state: ImportState): ImportTarget | null {
  const local = state.local;
  if (local) {
    const schemes = [...new Set(local.rows.map((row) => row.scheme))];
    const rootIds = local.rows
      .filter((row) => row.kind === "dir" && row.relPath === "")
      .map((row) => row.id);
    // A Meridian export's rows go to several areas at once; each opens.
    if (schemes.length > 1 || (schemes.length === 1 && schemes[0] !== local.destination.scheme))
      return { schemes, destination: null, rootIds, anchors: anchorsOf(null, schemes) };
    return {
      schemes: [local.destination.scheme],
      destination: local.destination,
      rootIds,
      anchors: anchorsOf(local.destination, [local.destination.scheme]),
    };
  }
  const report = state.report;
  if (!report) return null;
  const destination = destinationFromSummary(report.summary);
  const rootIds = fullyRead(report)
    ? report.roots.flatMap((root) => (root.kind === "folder" && root.id ? [root.id] : []))
    : [];
  if (fullyRead(report) && report.roots.length === 1 && report.roots[0].id === null) {
    const schemes = new Set<ImportScheme>();
    for (const folder of report.folders.values()) schemes.add(folder.scheme);
    for (const entry of report.entries.values()) schemes.add(entry.scheme);
    if (schemes.size > 0)
      return {
        schemes: [...schemes],
        destination: null,
        rootIds,
        anchors: anchorsOf(null, [...schemes]),
      };
  }
  return {
    schemes: [destination.scheme],
    destination,
    rootIds,
    anchors: anchorsOf(destination, [destination.scheme]),
  };
}
