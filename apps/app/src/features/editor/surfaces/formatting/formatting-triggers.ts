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
 * The right-click arrives at one of two rungs, and they ask different
 * questions of the same menu:
 *
 * - `text-selection` — the writer swept prose and pointed inside it. The menu
 *   acts on that sweep.
 * - `caret` — the ladder's floor. Every right-click in prose that no rung
 *   above wanted lands here (human ruling, 2026-07-29), and the caret moves to
 *   where the writer pointed so the verbs act on the block they aimed at.
 *
 * The keyboard twin asks the first question only: Shift+F10 has no pointer, so
 * there is nowhere to move a caret TO, and a menu over the caret the writer is
 * already sitting in is what the key already means.
 */

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
 * The claim decision for one right-click on a selection, synchronous by
 * contract.
 *
 * Read-only documents decline. The trade the claim makes is the browser's menu
 * for the editor's verbs, and a document the writer cannot change has no verbs
 * to offer beyond Copy, which the browser's menu already has.
 */
export function claimsFormattingMenu(editor: Editor, target: ContextClaimTarget): boolean {
  if (!menuCouldOpenOver(editor, target)) return false;
  // The kernel has already checked that the selection is prose and that the
  // pointer sits inside it. Not "a selection exists": a selection three
  // paragraphs away is not what the writer is pointing at.
  return target.insideTextSelection;
}

/**
 * The claim decision at the ladder's floor: a right-click in prose that no
 * more specific rung wanted.
 *
 * It does not ask about the selection at all, which is the point — a bare
 * caret and a right-click three paragraphs away from a sweep are the same
 * gesture, and both mean "give me the verbs for HERE". `placeCaretForMenu` is
 * what makes "here" true before the menu reads the document.
 *
 * A pointer with no document position under it declines: outside the prose
 * there is no block to aim the verbs at, and a menu over the editor's margin
 * would act on wherever the caret happened to be left.
 */
export function claimsCaretFormattingMenu(editor: Editor, target: ContextClaimTarget): boolean {
  if (target.docPos === null) return false;
  return menuCouldOpenOver(editor, target);
}

/** What both rungs ask: a writable document, prose under the pointer, no chrome. */
function menuCouldOpenOver(editor: Editor, target: ContextClaimTarget): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  // A grip or an object row is chrome standing over the prose; its own lane
  // takes those right-clicks, further up the ladder than either rung.
  const chrome = getEditorChrome(editor);
  if (chrome && isEditorChromeElement(chrome, target.element)) return false;
  // What the POINTER is over, which is the finer answer: the writer aimed at a
  // place, and that place may be a diagram or a fence.
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
