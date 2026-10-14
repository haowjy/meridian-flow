/** How a source filename reads in the tree: notes lose their suffix, pictures and PDFs keep theirs. */
import { parseDocumentFilename, renderFilename } from "@meridian/contracts/protocol";

export function filenameForDisplay(filename: string): string {
  const parsed = parseDocumentFilename(filename);
  return parsed.ok ? renderFilename(parsed.value.name, parsed.value.extension) : filename;
}
