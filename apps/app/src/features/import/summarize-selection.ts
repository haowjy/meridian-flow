/** What the dialog says about a selection: counts per root, limits, warnings. Pure. */

import { readExportMarker } from "./export-marker";
import { IMPORT_FILE_LIMITS } from "./limits";
import { rootTotals, type Selection, selectionTotals } from "./selection";

export type RootSummary = {
  rootId: number;
  kind: "folder" | "file";
  name: string;
  files: number;
  folders: number;
  /** Files in this root that could not be read. */
  unreadableFiles: number;
  /** Folders in this root that could not be listed. */
  unreadablePaths: string[];
  zip: boolean;
};

export type SelectionSummary = {
  roots: RootSummary[];
  files: number;
  folders: number;
  bytes: number;
  oversize: number;
  leftOut: Selection["leftOut"];
  /** One folder holding `meridian-export.json`. */
  meridianExport: { hasWorks: boolean } | null;
  limit: "ok" | "empty" | "too-many" | "too-big";
};

export function summarizeSelection(selection: Selection): SelectionSummary {
  const roots = selection.roots.map<RootSummary>((root) => {
    const totals = rootTotals(root, IMPORT_FILE_LIMITS.fileBytes);
    const unreadablePaths = root.unreadable
      .filter((item) => item.reason === "folder_unreadable")
      .map((item) => item.path);
    return {
      rootId: root.rootId,
      kind: root.kind,
      name: root.name,
      files: totals.files,
      folders: totals.folders,
      unreadableFiles: root.unreadable.length - unreadablePaths.length,
      unreadablePaths,
      zip: root.kind === "file" && /\.zip$/i.test(root.name),
    };
  });
  const totals = selectionTotals(selection, IMPORT_FILE_LIMITS.fileBytes);
  const only = selection.roots.length === 1 ? selection.roots[0] : null;
  const marker = only?.kind === "folder" ? readExportMarker(only.meridianExport) : null;
  const limit =
    totals.files === 0
      ? "empty"
      : totals.files > IMPORT_FILE_LIMITS.files
        ? "too-many"
        : totals.bytes > IMPORT_FILE_LIMITS.totalBytes
          ? "too-big"
          : "ok";
  return {
    roots,
    files: totals.files,
    folders: totals.folders,
    bytes: totals.bytes,
    oversize: totals.oversize,
    leftOut: selection.leftOut,
    meridianExport: marker ? { hasWorks: marker.hasWorks } : null,
    limit,
  };
}
