import { CONTEXT_URI_SCHEME_NAMES } from "./context-uri.js";

export const EXPORT_MARKER_FILENAME = "meridian-export.json";

export const EXPORT_AREAS = ["manuscript", "kb", "unfiled"] as const;
export type ExportArea = (typeof EXPORT_AREAS)[number];

export const DEFAULT_EXPORT_AREA_NAMES: Readonly<Record<ExportArea, string>> = {
  manuscript: CONTEXT_URI_SCHEME_NAMES.manuscript,
  kb: CONTEXT_URI_SCHEME_NAMES.kb,
  unfiled: CONTEXT_URI_SCHEME_NAMES.unfiled,
};

export const EXPORT_WORKS_FOLDER = "Works";

export type ExportMarker = {
  formatVersion: 1;
  areas: Record<ExportArea, string>;
  works: boolean;
  excludedLinks: number;
};

export type ParsedExportMarker =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; areas: ReadonlyMap<string, ExportArea> };

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
