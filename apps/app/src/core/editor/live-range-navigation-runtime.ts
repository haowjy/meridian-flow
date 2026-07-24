/** Active live-editor registry used by document navigation after route mounting. */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { relativeRangeToEditorPositions } from "./extensions/LiveRangeNavigationExtension";

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

export function showPeerMarkerInEditor(documentId: string, changeId: string): { shown: boolean } {
  for (const editor of activeEditors(documentId)) {
    if (editor.commands.showPeerMarker(changeId)) return { shown: true };
  }
  return { shown: false };
}
