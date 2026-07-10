/** Active live-editor registry used by document navigation after route mounting. */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { relativeRangeToEditorPositions } from "./extensions/LiveRangeNavigationExtension";

const editors = new Map<string, Editor>();

export function registerLiveRangeEditor(documentId: string, editor: Editor): () => void {
  editors.set(documentId, editor);
  return () => {
    if (editors.get(documentId) === editor) editors.delete(documentId);
  };
}

export function showLiveRangeInEditor(
  documentId: string,
  range: { start: Y.RelativePosition; end: Y.RelativePosition },
  boundary = false,
): { shown: boolean; currentText: string | null } {
  const editor = editors.get(documentId);
  if (!editor || editor.isDestroyed) return { shown: false, currentText: null };
  const positions = relativeRangeToEditorPositions(editor, range);
  if (!positions) return { shown: false, currentText: null };
  const shown = boundary
    ? editor.commands.showLivePosition(range.start)
    : editor.commands.showLiveRange(range);
  return {
    shown,
    currentText: boundary ? null : editor.state.doc.textBetween(positions.from, positions.to, "\n"),
  };
}
