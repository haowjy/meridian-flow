import type { Editor } from "@tiptap/core";

import {
  type ContextClaimTarget,
  getEditorChrome,
  isEditorChromeElement,
} from "@/core/editor/chrome";

export function fenceUnderPointer(editor: Editor, target: ContextClaimTarget): number | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  if (target.context.owner !== "source-block" || target.context.pos === null) return null;
  const chrome = getEditorChrome(editor);
  if (chrome && isEditorChromeElement(chrome, target.element)) return null;
  return target.context.pos;
}
