/** Whether a document stores a code file (one code node) rather than prose blocks. */
import { classifyFiletype } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";

/**
 * A code document's filetype, or null for a prose document. Throws for a filetype that has no
 * text room: nothing derives or reads one as text.
 */
export async function codeFiletypeOf(
  resolveFiletype: (documentId: DocumentId) => Promise<string | null>,
  documentId: DocumentId,
): Promise<string | null> {
  const filetype = await resolveFiletype(documentId);
  const classification = classifyFiletype(filetype);
  if (classification.kind === "tracked")
    return classification.schemaType === "code" ? filetype : null;
  if (classification.kind === "unknown") return null;
  throw new Error(`Document ${documentId} has untracked filetype ${filetype} and no text`);
}

/** A code file's grep text is its code node's text, not markdown. */
export async function isCodeDocument(
  resolveFiletype: (documentId: DocumentId) => Promise<string | null>,
  documentId: DocumentId,
): Promise<boolean> {
  return (await codeFiletypeOf(resolveFiletype, documentId)) !== null;
}
