/** Names the server would refuse, and the NFC form it requires. */
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";

/** The server needs NFC names; macOS file systems hand some out decomposed. */
export function normalizeName(name: string): string {
  return name.normalize("NFC");
}

/** NFC on every segment of a `/` path; no dot-segment folding or percent decoding. */
export function normalizeNamePath(path: string): string {
  return path.split("/").map(normalizeName).join("/");
}

/** Whether Meridian can name an entry this. A refused name would refuse the whole import. */
export function isImportableName(name: string): boolean {
  return name.length > 0 && validateContextEntryName(normalizeName(name)).ok;
}

export function isImportablePath(path: string): boolean {
  return path === "" || path.split("/").every(isImportableName);
}
