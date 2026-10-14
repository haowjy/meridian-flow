/**
 * The `meridian-export.json` marker: the one wire format an export writes and an
 * import reads back. Export serializes an `ExportMarker`; the app (optimistic
 * rows) and the server (planning) both read it through `parseExportMarker`.
 * Whether a selection may carry a marker (exactly one selected folder root) is
 * the server's admission rule, not part of the format.
 */

export const EXPORT_MARKER_FILENAME = "meridian-export.json";

export const EXPORT_AREAS = ["manuscript", "kb", "unfiled"] as const;
export type ExportArea = (typeof EXPORT_AREAS)[number];

/** Top-level folder each area gets in an export, unless a marker names others. */
export const DEFAULT_EXPORT_AREA_NAMES: Readonly<Record<ExportArea, string>> = {
  manuscript: "Manuscript",
  kb: "Knowledge Base",
  unfiled: "Unfiled",
};

/** The top-level folder that holds Works; an import never lands it, so no area may use it. */
export const EXPORT_WORKS_FOLDER = "Works";

export type ExportMarker = {
  formatVersion: 1;
  /** Folder name each area was exported under. */
  areas: Record<ExportArea, string>;
  /** Whether the export carries a `Works/` folder. */
  works: boolean;
  excludedLinks: number;
};

export type ParsedExportMarker =
  | { status: "absent" }
  | { status: "invalid" }
  /** `areas` maps a top-level folder name back to the area it returns to. */
  | { status: "valid"; areas: ReadonlyMap<string, ExportArea> };

/** `undefined` text means the folder has no marker; anything else must be a well-formed version 1. */
export function parseExportMarker(text: string | undefined): ParsedExportMarker {
  if (text === undefined) return { status: "absent" };
  try {
    const marker = JSON.parse(text);
    if (
      marker?.formatVersion !== 1 ||
      typeof marker.works !== "boolean" ||
      !marker.areas ||
      typeof marker.areas !== "object"
    )
      return { status: "invalid" };
    const areas = new Map<string, ExportArea>();
    for (const area of EXPORT_AREAS) {
      const name = marker.areas[area];
      if (
        typeof name !== "string" ||
        !name ||
        name.includes("/") ||
        name.startsWith(".") ||
        name === EXPORT_WORKS_FOLDER ||
        areas.has(name)
      )
        return { status: "invalid" };
      areas.set(name, area);
    }
    return { status: "valid", areas };
  } catch {
    return { status: "invalid" };
  }
}
