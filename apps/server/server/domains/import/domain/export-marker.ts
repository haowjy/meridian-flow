/** The visible versioned export marker routes only a whole selected project folder. */
import { type ExportArea, type ImportManifest, parseExportMarker } from "@meridian/contracts";
import { ImportError } from "./manifest.js";
export type ImportArea = ExportArea;
export function readExportMarker(manifest: ImportManifest) {
  const roots = manifest.roots.filter((root) => root.meridianExport !== undefined);
  if (!roots.length) return null;
  if (manifest.roots.length !== 1 || roots[0].kind !== "folder")
    throw new ImportError(400, "export_marker_root");
  const marker = parseExportMarker(roots[0].meridianExport);
  if (marker.status !== "valid") throw new ImportError(400, "export_marker_invalid");
  return { rootId: roots[0].rootId, areas: marker.areas };
}
