/** Whether a document stores a code file (one code node) rather than prose blocks. */
import { classifyFiletype } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";

/**
 * A code file's grep text is its code node's text, not markdown. Throws for a filetype that
 * has no Yjs state: nothing derives or reads one as text.
 */
export async function isCodeDocument(
  resolveFiletype: (documentId: DocumentId) => Promise<string | null>,
  documentId: DocumentId,
): Promise<boolean> {
  const filetype = await resolveFiletype(documentId);
  const classification = classifyFiletype(filetype);
  if (classification.kind === "tracked") return classification.schemaType === "code";
  if (classification.kind === "unknown") return false;
  throw new Error(`Document ${documentId} has untracked filetype ${filetype} and no text`);
}
