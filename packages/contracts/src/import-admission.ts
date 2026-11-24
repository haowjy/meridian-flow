import { EXPORT_MARKER_FILENAME } from "./export-marker.js";
import type { ImportSkipReason } from "./imports.js";

export const IMPORT_ADMISSION = {
  files: 10_000,
  totalBytes: 2 * 1024 ** 3,
  fileBytes: 50 * 1024 * 1024,
  requestBytes: 8 * 1024 * 1024,
  partsPerRequest: 200,
  sideFileBytes: 1024 * 1024,
} as const;

export function importFileCount(readable: number, unreadable: number): number {
  return readable + unreadable;
}

export function overFileBudget(readable: number, unreadable: number): boolean {
  return importFileCount(readable, unreadable) > IMPORT_ADMISSION.files;
}

const NEVER_SENT_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export function importPathDisposition(path: string): "omit" | ImportSkipReason | null {
  const segments = path.split("/");
  if (
    segments[0] === ".obsidian" ||
    segments[0] === ".git" ||
    path === EXPORT_MARKER_FILENAME ||
    segments.some((segment) => NEVER_SENT_NAMES.has(segment))
  )
    return "omit";
  if (segments.some((segment) => segment.startsWith(".")))
    return segments[0] === ".trash" ? "trash" : "hidden";
  if (/\.(canvas|base)$/i.test(path)) return "obsidian_canvas";
  return null;
}
