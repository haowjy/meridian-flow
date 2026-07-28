/** Active live-editor registry used by document navigation after route mounting. */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { relativeRangeToEditorPositions } from "./extensions/LiveRangeNavigationExtension";
import { resolvePassage } from "./passage-resolution";

const editors = new Map<string, Set<Editor>>();

export function registerLiveRangeEditor(documentId: string, editor: Editor): () => void {
  const documentEditors = editors.get(documentId) ?? new Set<Editor>();
  documentEditors.add(editor);
  editors.set(documentId, documentEditors);
  return () => {
    const current = editors.get(documentId);
    current?.delete(editor);
    if (current?.size === 0) editors.delete(documentId);
  };
}

function activeEditors(documentId: string): Editor[] {
  return [...(editors.get(documentId) ?? [])]
    .filter((editor) => !editor.isDestroyed)
    .sort(
      (left, right) =>
        Number(right.view.dom.offsetParent !== null) - Number(left.view.dom.offsetParent !== null),
    );
}

export function showLiveRangeInEditor(
  documentId: string,
  range: { start: Y.RelativePosition; end: Y.RelativePosition },
  boundary = false,
): { shown: boolean } {
  const editor = activeEditors(documentId)[0];
  if (!editor) return { shown: false };
  const positions = relativeRangeToEditorPositions(editor, range);
  if (!positions) return { shown: false };
  const shown = boundary
    ? editor.commands.showLivePosition(range.start)
    : editor.commands.showLiveRange(range);
  return { shown };
}

/**
 * Run a search hit's resolution ladder against the mounted editor and mark
 * what it found. `null` means no editor has taken this document yet (or its
 * Yjs binding has not landed) — the caller retries; it is not an answer about
 * the passage.
 */
export function showPassageInEditor(
  documentId: string,
  target: {
    /** The block the hash resolved to, or null when the hash names none. */
    block: { start: Y.RelativePosition; end: Y.RelativePosition } | null;
    term: string;
  },
): { outcome: "landed" | "stale" } | null {
  const editor = activeEditors(documentId)[0];
  if (!editor) return null;
  const blockRange = target.block ? relativeRangeToEditorPositions(editor, target.block) : null;
  // The block is live in Yjs (the caller just looked it up), so a range that
  // will not resolve means the binding is still coming up, not that the
  // passage is gone.
  if (target.block && !blockRange) return null;
  const resolution = resolvePassage(editor.state.doc, blockRange, target.term);
  if (resolution.kind === "stale") return { outcome: "stale" };
  return editor.commands.showPassageMatches(resolution.ranges) ? { outcome: "landed" } : null;
}

export function showPeerMarkerInEditor(documentId: string, changeId: string): { shown: boolean } {
  for (const editor of activeEditors(documentId)) {
    if (editor.commands.showPeerMarker(changeId)) return { shown: true };
  }
  return { shown: false };
}
