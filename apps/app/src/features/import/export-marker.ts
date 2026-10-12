/** Reads a Meridian export's marker: which folder names go back to which area. */
import type { ImportScheme } from "./destination";

export type ExportMarker = {
  /** Top-level folder name to the area it returns to. */
  areas: ReadonlyMap<string, ImportScheme>;
  hasWorks: boolean;
};

/** Null when the text is not a marker this version of the app understands. */
export function readExportMarker(text: string | undefined): ExportMarker | null {
  if (text === undefined) return null;
  try {
    const marker = JSON.parse(text);
    if (marker?.formatVersion !== 1 || typeof marker.areas !== "object" || !marker.areas)
      return null;
    const areas = new Map<string, ImportScheme>();
    for (const scheme of ["manuscript", "kb", "unfiled"] as const) {
      const name = marker.areas[scheme];
      if (typeof name !== "string" || !name) return null;
      areas.set(name, scheme);
    }
    return { areas, hasWorks: Boolean(marker.works) };
  } catch {
    return null;
  }
}
