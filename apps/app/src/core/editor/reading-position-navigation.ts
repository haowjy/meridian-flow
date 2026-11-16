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

/** The editor reopened at the writer's place; only the review's first reconcile after that mount yields to it. */
export function markRestoredPlace(editor: Editor): void {
  restored.add(editor);
}

export function keepsRestoredPlace(editor: Editor): boolean {
  return restored.has(editor);
}

export function mayRestoreReadingPosition(editor: Editor, documentId: string): boolean {
  return !pending.has(documentId) && !targeted.has(editor);
}

const reviewEditors = new Map<string, Set<Editor>>();
const reviewEditorWaiters = new Map<string, Set<() => void>>();

/** A review (Draft view) editor of the document has decided whether to restore a place. */
export function reportReviewEditorMounted(documentId: string, editor: Editor): () => void {
  const editors = reviewEditors.get(documentId) ?? new Set<Editor>();
  editors.add(editor);
  reviewEditors.set(documentId, editors);
  for (const wake of reviewEditorWaiters.get(documentId) ?? []) wake();
  return () => {
    editors.delete(editor);
    if (!editors.size) reviewEditors.delete(documentId);
  };
}

/** Resolves when a review editor of the document has mounted; `signal` bounds a mount that never comes. */
export function whenReviewEditorMounted(documentId: string, signal: AbortSignal): Promise<void> {
  if (reviewEditors.has(documentId) || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = reviewEditorWaiters.get(documentId) ?? new Set<() => void>();
    const done = () => {
      signal.removeEventListener("abort", done);
      waiters.delete(done);
      if (!waiters.size) reviewEditorWaiters.delete(documentId);
      resolve();
    };
    waiters.add(done);
    reviewEditorWaiters.set(documentId, waiters);
    signal.addEventListener("abort", done, { once: true });
  });
}
