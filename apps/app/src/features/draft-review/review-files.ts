/** File navigation and display names over the Work draft list's projection. */
import {
  documentBasename,
  type ReviewFileTarget,
  sortDraftFiles,
} from "@/client/query/work-draft-files";

/**
 * The draft the review moves to when the writer is done with this one: the next
 * document in the file order, wrapping to the first, and none when this is
 * the only one left (the review then returns to live).
 */
export function nextReviewFile(
  rows: readonly ReviewFileTarget[],
  documentId: string,
  /** The document's name once its draft has left the list: it keeps its place in the order. */
  closedName: string | null = null,
): ReviewFileTarget | null {
  const others = rows.filter((row) => row.documentId !== documentId);
  if (others.length === 0) return null;
  let at = rows.findIndex((row) => row.documentId === documentId);
  let ordered = rows;
  if (at < 0 && closedName !== null) {
    const closed = { documentId, documentName: closedName, contextPath: null };
    ordered = sortDraftFiles([...rows, closed]) as readonly ReviewFileTarget[];
    at = ordered.findIndex((row) => row.documentId === documentId);
  }
  const after = at < 0 ? [] : ordered.slice(at + 1).filter((row) => row.documentId !== documentId);
  return after[0] ?? others[0];
}

/**
 * What a draft's document is called: its name, else (for a new document the AI
 * created unnamed) the basename of its path, then a defensive label.
 */
export function reviewFileTargetName(row: ReviewFileTarget, untitled: string): string {
  return (
    row.documentName ??
    (row.isNewDocument ? (documentBasename(row.contextPath) ?? untitled) : row.documentId)
  );
}
