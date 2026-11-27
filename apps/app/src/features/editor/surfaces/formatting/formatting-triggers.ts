import type { Editor } from "@tiptap/core";
import { type EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import {
  type ChromeContext,
  type ChromeContextKind,
  type ContextClaimTarget,
  getEditorChrome,
  isEditorChromeElement,
  proseSelectionCovers,
  resolveChromeContext,
} from "@/core/editor/chrome";

export type FormattingMenuPoint = { x: number; y: number };

const FORMATTING_MENU_CONTEXTS: readonly ChromeContextKind[] = ["document", "table", "table-cell"];

export function formattingOwnsContext(context: ChromeContext): boolean {
  return FORMATTING_MENU_CONTEXTS.includes(context.owner);
}

export function isProseSelection(state: EditorState): boolean {
  return proseSelectionCovers(state, state.selection.from);
}

export function formattingMenuOpensFor(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  if (!isProseSelection(editor.state)) return false;
  return formattingOwnsContext(resolveChromeContext(editor.state));
}

export function claimsFormattingMenu(editor: Editor, target: ContextClaimTarget): boolean {
  if (!menuCouldOpenOver(editor, target)) return false;
  return target.insideTextSelection;
}

export function claimsCaretFormattingMenu(editor: Editor, target: ContextClaimTarget): boolean {
  if (target.docPos === null) return false;
  return menuCouldOpenOver(editor, target);
}

function menuCouldOpenOver(editor: Editor, target: ContextClaimTarget): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const chrome = getEditorChrome(editor);
  if (chrome && isEditorChromeElement(chrome, target.element)) return false;
  return formattingOwnsContext(target.context);
}

/**
 * Move the caret to where the right-click landed, before the menu reads the
 * document.
 *
 * Load-bearing rather than tidy: Turn into converts the block the SELECTION is
 * in, so a menu opened over the third paragraph while the caret sat in the
 * first would convert the first. Chrome moves the caret on right-click and
 * Firefox does not, so the editor does it itself and both behave the same.
 *
 * `TextSelection.near` because a position under the pointer is not promised to
 * hold a caret — the gap between two blocks resolves to one that does not —
 * and it walks to the nearest that does.
 */
export function placeCaretForMenu(editor: Editor, pos: number): boolean {
  if (editor.isDestroyed) return false;
  const { state } = editor.view;
  const clamped = Math.max(0, Math.min(pos, state.doc.content.size));
  const selection = TextSelection.near(state.doc.resolve(clamped));
  editor.view.dispatch(state.tr.setSelection(selection));
  return true;
}

export function selectionAnchorPoint(view: EditorView): FormattingMenuPoint | null {
  try {
    const coords = view.coordsAtPos(view.state.selection.to);
    return { x: coords.left, y: coords.bottom };
  } catch {
    return null;
  }
}
