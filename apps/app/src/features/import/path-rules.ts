/** The names an import can carry unchanged (a path segment a file system could not hold is left out), and the NFC form it requires. */
import { normalEntryName } from "@meridian/contracts/context-entry-validation";

/** The server needs NFC names; macOS file systems hand some out decomposed. */
export function normalizeName(name: string): string {
  return name.normalize("NFC");
}

/** Whether Meridian can name an entry this. A refused name would refuse the whole import. */
export function isImportableName(name: string): boolean {
  const nfc = normalizeName(name);
  return name.length > 0 && normalEntryName("folder", nfc) === nfc;
}

export function isImportablePath(path: string): boolean {
  return path === "" || path.split("/").every(isImportableName);
}
