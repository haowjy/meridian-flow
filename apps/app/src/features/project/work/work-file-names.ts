/** Stable sibling-safe names for new Scratch notes. */
import { parseDocumentFilename, renderFilename } from "@meridian/contracts/protocol";

/**
 * The first free name from `baseName`, numbered the way the server numbers a
 * clash: before the extension, `Vol. 2 (2)` and `note (2).json`. The codec
 * says what the extension is, so a dotted prose name is not split.
 */
export function uniqueScratchNoteName(baseName: string, siblingNames: readonly string[]): string {
  const occupied = new Set(siblingNames);
  if (!occupied.has(baseName)) return baseName;

  const parsed = parseDocumentFilename(baseName);
  const { name, extension } = parsed.ok ? parsed.value : { name: baseName, extension: "" };
  let suffix = 2;
  while (occupied.has(renderFilename(`${name} (${suffix})`, extension))) suffix += 1;
  return renderFilename(`${name} (${suffix})`, extension);
}
