/** The visible versioned export marker routes only a whole selected project folder. */
import type { ImportManifest } from "@meridian/contracts";
import { ImportError } from "./manifest.js";
export type ImportArea = "manuscript" | "kb" | "unfiled";
export function readExportMarker(manifest: ImportManifest) {
  const roots = manifest.roots.filter((root) => root.meridianExport !== undefined);
  if (!roots.length) return null;
  if (manifest.roots.length !== 1 || roots[0].kind !== "folder")
    throw new ImportError(400, "Export marker requires one project folder");
  try {
    const marker = JSON.parse(roots[0].meridianExport ?? "");
    if (
      marker.formatVersion !== 1 ||
      marker.works !== Boolean(marker.works) ||
      !marker.areas ||
      typeof marker.areas !== "object"
    )
      throw new Error("marker");
    const areas = new Map<string, ImportArea>();
    for (const area of ["manuscript", "kb", "unfiled"] as const) {
      const name = marker.areas[area];
      if (
        typeof name !== "string" ||
        !name ||
        name.includes("/") ||
        name.startsWith(".") ||
        name === "Works" ||
        areas.has(name)
      )
        throw new Error("area");
      areas.set(name, area);
    }
    return { rootId: roots[0].rootId, areas };
  } catch {
    throw new ImportError(400, "Invalid Meridian export marker");
  }
}
