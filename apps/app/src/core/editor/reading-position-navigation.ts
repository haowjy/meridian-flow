/**
 * One precedence rule: an arrival at a target (a passage door, a review launch, a mark press)
 * beats mount-time memory. A reload or a pasted address is not an arrival: the writer's own
 * place wins, including over the change the address names.
 */
import type { Editor } from "@tiptap/core";

const pending = new Map<string, Set<object>>();
const targeted = new WeakSet<Editor>();
const restored = new WeakSet<Editor>();

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

export function markRestoredPlace(editor: Editor): void {
  restored.add(editor);
}

export function keepsRestoredPlace(editor: Editor): boolean {
  return restored.has(editor);
}

export function mayRestoreReadingPosition(editor: Editor, documentId: string): boolean {
  return !pending.has(documentId) && !targeted.has(editor);
}

const mountedEditors = new Map<string, Set<Editor>>();
const mountWaiters = new Map<string, Set<() => void>>();

export function reportEditorMounted(documentId: string, editor: Editor): () => void {
  const editors = mountedEditors.get(documentId) ?? new Set<Editor>();
  editors.add(editor);
  mountedEditors.set(documentId, editors);
  for (const wake of mountWaiters.get(documentId) ?? []) wake();
  return () => {
    editors.delete(editor);
    if (!editors.size) mountedEditors.delete(documentId);
  };
}

export function whenEditorMounted(documentId: string, signal: AbortSignal): Promise<void> {
  if (mountedEditors.has(documentId) || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = mountWaiters.get(documentId) ?? new Set<() => void>();
    const done = () => {
      signal.removeEventListener("abort", done);
      waiters.delete(done);
      if (!waiters.size) mountWaiters.delete(documentId);
      resolve();
    };
    waiters.add(done);
    mountWaiters.set(documentId, waiters);
    signal.addEventListener("abort", done, { once: true });
  });
}
