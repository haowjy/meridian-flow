/** One precedence rule: an explicit destination always beats mount-time memory. */
import type { Editor } from "@tiptap/core";

const pending = new Map<string, Set<object>>();
const targeted = new WeakSet<Editor>();

/** Claim before opening a document, including while its editor is still mounting. */
export function claimDocumentTarget(documentId: string): () => void {
  const owners = pending.get(documentId) ?? new Set<object>();
  const owner = {};
  owners.add(owner);
  pending.set(documentId, owners);
  return () => {
    owners.delete(owner);
    if (!owners.size) pending.delete(documentId);
  };
}

export function markEditorTarget(editor: Editor): void {
  targeted.add(editor);
}

export function mayRestoreReadingPosition(
  editor: Editor,
  documentId: string,
  review: boolean,
  address: string,
): boolean {
  const url = new URL(address);
  return (
    !review &&
    !pending.has(documentId) &&
    !targeted.has(editor) &&
    !url.searchParams.has("draft") &&
    !url.hash
  );
}
