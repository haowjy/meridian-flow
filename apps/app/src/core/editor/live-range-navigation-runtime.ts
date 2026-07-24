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
): { shown: boolean } {
  const editor = editors.get(documentId);
  if (!editor || editor.isDestroyed) return { shown: false };
  const positions = relativeRangeToEditorPositions(editor, range);
  if (!positions) return { shown: false };
  const shown = boundary
    ? editor.commands.showLivePosition(range.start)
    : editor.commands.showLiveRange(range);
  return { shown };
}

export function showPeerMarkerInEditor(documentId: string, changeId: string): { shown: boolean } {
  const editor = editors.get(documentId);
  if (!editor || editor.isDestroyed) return { shown: false };
  return { shown: editor.commands.showPeerMarker(changeId) };
}
