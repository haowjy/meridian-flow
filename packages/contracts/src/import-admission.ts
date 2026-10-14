/**
 * What an import will accept, defined once for the browser (which refuses and
 * batches by it) and the server (which stays the authority and validates
 * everything again). Server-only tuning (leases, sweeps, chunk size, landing
 * concurrency) and browser-only scheduling (hash and request concurrency) are
 * not here.
 */
import { EXPORT_MARKER_FILENAME } from "./export-marker.js";
import type { ImportSkipReason } from "./imports.js";

export const IMPORT_ADMISSION = {
  /** Files in one import. Counts every manifest entry plus every unreadable item. */
  files: 10_000,
  /** Bytes in one import, summed over the files that are sent. */
  totalBytes: 2 * 1024 ** 3,
  /** A larger file is listed and skipped, never read or sent. */
  fileBytes: 50 * 1024 * 1024,
  /** Bytes one multipart request may carry when it holds more than one file. */
  requestBytes: 8 * 1024 * 1024,
  /** Files one multipart request may carry. */
  partsPerRequest: 200,
  /** Leading bytes of a file the manifest carries for type sniffing. */
  sniffBytes: 512,
  /** Upper bound on a settings or marker side file the manifest carries. */
  sideFileBytes: 1024 * 1024,
} as const;

const NEVER_SENT_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * What happens to a path below a selected folder. "omit": never sent and never
 * reported. A reason: recorded as skipped. null: imported. Only a root-level
 * `.git` is omitted; a nested `.git` is a hidden folder and so is skipped.
 */
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
