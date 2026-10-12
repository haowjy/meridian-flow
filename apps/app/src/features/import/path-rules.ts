/** Names and paths the browser never sends, and names the server would refuse. */
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";

const NEVER_SENT_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Whether a path below a selected folder is left out entirely: not sent, not
 * reported. Mirrors the server's "omit" rule so `.git` and Obsidian's settings
 * folder are never walked or hashed. The server stays the authority for what is
 * skipped and reported (trash, hidden files, canvases).
 */
export function isOmittedPath(path: string): boolean {
  const segments = path.split("/");
  return (
    segments[0] === ".obsidian" ||
    segments[0] === ".git" ||
    path === "meridian-export.json" ||
    segments.some((segment) => NEVER_SENT_NAMES.has(segment))
  );
}

/** The server needs NFC names; macOS file systems hand some out decomposed. */
export function normalizeName(name: string): string {
  return name.normalize("NFC");
}

/** Whether Meridian can name an entry this. A refused name would refuse the whole import. */
export function isImportableName(name: string): boolean {
  return name.length > 0 && validateContextEntryName(normalizeName(name)).ok;
}

export function isImportablePath(path: string): boolean {
  return path === "" || path.split("/").every(isImportableName);
}

/**
 * Whether the server will skip a file under these rules (hidden files and
 * folders, Obsidian's trash, canvases and bases). The tree draws no row for
 * one, so the rows match what will arrive; the report still lists them.
 */
export function isSkippedPath(path: string): boolean {
  return (
    path.split("/").some((segment) => segment.startsWith(".")) || /\.(canvas|base)$/i.test(path)
  );
}
