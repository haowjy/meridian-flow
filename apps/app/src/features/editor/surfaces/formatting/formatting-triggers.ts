/**
 * When the formatting menu opens, and where it hangs.
 *
 * Two doors lead to one open call (§5.1): a right-click the kernel's claim
 * ladder routes here, and the Menu key or Shift+F10. Touch has no third door of
 * its own — a long press IS a `contextmenu` on every browser that gives the
 * page one, so it arrives through the ladder like any other right-click, which
 * is the only way a link or an object under the finger can outrank this rung.
 * See `.context/CONTEXT.md` for the platforms that give no such event.
 *
 * Both doors ask the same two questions, and they live here as pure ones so the
 * split matrix is testable without a pointer:
 *
 * 1. is the selection prose this menu can format?
 * 2. is the context under it one this menu owns?
 *
 * The answers are deliberately narrow. Claiming costs the writer the browser's
 * own menu, and ruling 11 makes that menu load-bearing: spellcheck, lookup, and
 * OS services live in it.
 */

import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import {
  type ChromeContext,
  type ChromeContextKind,
  type ContextClaimTarget,
  editorChromeAttributes,
  getEditorChrome,
  proseSelectionCovers,
  resolveChromeContext,
} from "@/core/editor/chrome";

export type FormattingMenuPoint = { x: number; y: number };

/**
 * Contexts whose prose this menu formats. A table cell's text is prose (§5.4),
 * so the cell keeps its own chain but the words in it are ours.
 *
 * Two contexts are missing on purpose. An object has no text to format, and a
 * source block belongs to the code strip (§5.3, law 4): a menu offering Heading
 * over a fence is the F6 accident, and a menu offering nothing over one is a
 * menu that took the browser's for no gain.
 */
const FORMATTING_MENU_CONTEXTS: readonly ChromeContextKind[] = ["document", "table", "table-cell"];

export function formattingOwnsContext(context: ChromeContext): boolean {
  return FORMATTING_MENU_CONTEXTS.includes(context.owner);
}

/**
 * A selection this menu can act on, in the kernel's own words: non-empty, and
 * prose rather than an object or a whole table. `AllSelection` counts — Ctrl+A
 * then format the chapter is an ordinary gesture, and the command fence greys
 * whatever the sweep caught.
 */
export function isProseSelection(state: EditorState): boolean {
  return proseSelectionCovers(state, state.selection.from);
}

/**
 * Whether the keyboard door should open the menu at all. The same two questions
 * the claim asks, minus the pointer: Shift+F10 over a selected code fence must
 * decline exactly where a right-click on it does.
 */
export function formattingMenuOpensFor(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  if (!isProseSelection(editor.state)) return false;
  return formattingOwnsContext(resolveChromeContext(editor.state));
}

/**
 * The claim decision for one right-click, synchronous by contract.
 *
 * Read-only documents decline. The trade the claim makes is the browser's menu
 * for the editor's verbs, and a document the writer cannot change has no verbs
 * to offer beyond Copy, which the browser's menu already has.
 */
export function claimsFormattingMenu(editor: Editor, target: ContextClaimTarget): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  // The kernel has already checked that the selection is prose and that the
  // pointer sits inside it. Not "a selection exists": a selection three
  // paragraphs away is not what the writer is pointing at.
  if (!target.insideTextSelection) return false;
  // A grip or an object row is chrome standing over the prose; its own lane
  // takes those right-clicks, further down the ladder than this rung.
  if (isEditorChrome(editor, target.element)) return false;
  // What the POINTER is over, which is the finer answer: the writer aimed at a
  // place inside their selection, and that place may be a diagram.
  return formattingOwnsContext(target.context);
}

function isEditorChrome(editor: Editor, element: Element): boolean {
  const chrome = getEditorChrome(editor);
  if (!chrome) return false;
  // Qualified by this editor's id, the way the kernel's own router qualifies
  // it: two documents side by side are two kernels, and an unqualified mark
  // would hand one editor's overlay row to both.
  return Object.entries(editorChromeAttributes(chrome)).some(
    ([attribute, value]) => element.closest(`[${attribute}="${value}"]`) !== null,
  );
}

/**
 * Where a menu the keyboard summoned hangs: the end of the selection, which is
 * where the writer's attention already is. Radix wants client coordinates, and
 * so the caret's own screen position is the anchor.
 */
export function selectionAnchorPoint(view: EditorView): FormattingMenuPoint | null {
  try {
    const coords = view.coordsAtPos(view.state.selection.to);
    return { x: coords.left, y: coords.bottom };
  } catch {
    // A position the view has not drawn yet (a collapsed node view, a
    // mid-transaction read) has no coordinates; the key falls through.
    return null;
  }
}
