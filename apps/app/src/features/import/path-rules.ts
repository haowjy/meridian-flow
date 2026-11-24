import { normalEntryName } from "@meridian/contracts/context-entry-validation";

export function normalizeName(name: string): string {
  return name.normalize("NFC");
}

export function isImportableName(name: string): boolean {
  const nfc = normalizeName(name);
  return name.length > 0 && normalEntryName("folder", nfc) === nfc;
}

export function isImportablePath(path: string): boolean {
  return path === "" || path.split("/").every(isImportableName);
}
