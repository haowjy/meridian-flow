/**
 * One precedence rule: an arrival at a target (a passage door, a review launch, a mark press)
 * beats mount-time memory. A reload or a pasted address is not an arrival: the writer's own
 * place wins, including over the change the address names.
 */
import type { Editor } from "@tiptap/core";

const pending = new Map<string, Set<object>>();
const targeted = new WeakSet<Editor>();
const restored = new WeakSet<Editor>();

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

/** A restored editor's place stands: later automatic scrolls (a review's focused change) yield to it. */
export function markRestoredPlace(editor: Editor): void {
  restored.add(editor);
}

export function keepsRestoredPlace(editor: Editor): boolean {
  return restored.has(editor);
}

export function mayRestoreReadingPosition(editor: Editor, documentId: string): boolean {
  return !pending.has(documentId) && !targeted.has(editor);
}
