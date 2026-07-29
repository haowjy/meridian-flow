/**
 * When the formatting menu opens, and where it hangs.
 *
 * Three doors lead to one open call (§5.1): a right-click the kernel's claim
 * ladder routes here, the Menu key or Shift+F10, and a long press on touch.
 * Only the first is a `contextmenu` event, so only the first is the kernel's
 * to route; the other two are this lane's. All three ask the same question,
 * and it lives here as a pure one so the split matrix is testable without a
 * pointer.
 *
 * The answer is deliberately narrow. Claiming a right-click costs the writer
 * the browser's own menu, and ruling 11 makes that menu load-bearing:
 * spellcheck, lookup, and OS services live in it. So the menu claims only what
 * the design says it owns and leaves everything else alone.
 */

import type { Editor } from "@tiptap/core";
import { AllSelection, type EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import {
  type ChromeContextKind,
  type ContextClaimTarget,
  EDITOR_CHROME_ATTRIBUTE,
} from "@/core/editor/chrome";

export type FormattingMenuPoint = { x: number; y: number };

/** How long a touch must rest before it counts as asking for the menu. */
export const LONG_PRESS_MS = 500;

/** Travel that turns a long press into a scroll or a selection drag. */
export const LONG_PRESS_SLOP_PX = 10;

/**
 * Contexts whose prose this menu formats. A table cell's text is prose (§5.4),
 * so the cell keeps its own chain but the words in it are ours.
 *
 * Two contexts are missing on purpose. An object has no text to format, and a
 * source block belongs to the code strip (§5.3, law 4) — a menu offering
 * Heading over a fence is the F6 accident, and a menu offering nothing over
 * one is a menu that took the browser's for no gain.
 */
const FORMATTING_MENU_CONTEXTS: readonly ChromeContextKind[] = ["document", "table", "table-cell"];

/**
 * A selection this menu can act on: prose the writer swept, not an object they
 * selected. `AllSelection` counts — Ctrl+A then right-click is an ordinary way
 * to reach the whole chapter, and the command fence greys what it must.
 */
export function isProseSelection(state: EditorState): boolean {
  const { selection } = state;
  if (selection.empty) return false;
  return selection instanceof TextSelection || selection instanceof AllSelection;
}

/** Whether the keyboard and long-press doors should open the menu at all. */
export function formattingMenuOpensFor(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  return isProseSelection(editor.state);
}

/**
 * The claim decision for one right-click, synchronous by contract.
 *
 * Read-only documents decline. The trade the claim makes is the browser's menu
 * for the editor's verbs, and a document the writer cannot change has no verbs
 * to offer beyond Copy, which the browser's menu already has.
 */
export function claimsFormattingMenu(editor: Editor, target: ContextClaimTarget): boolean {
  if (!formattingMenuOpensFor(editor)) return false;
  // Not "a selection exists": the writer must be pointing AT it, or the native
  // menu is being spent on a passage three paragraphs away.
  if (!target.insideTextSelection) return false;
  // A grip or an object row is chrome standing over the prose; its own lane
  // takes those right-clicks, further down the ladder than this rung.
  if (target.element.closest(`[${EDITOR_CHROME_ATTRIBUTE}]`)) return false;
  return FORMATTING_MENU_CONTEXTS.includes(target.context.owner);
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

/** Whether a touch landed on the selection rather than beside it. */
export function pointInsideSelection(view: EditorView, point: FormattingMenuPoint): boolean {
  const at = view.posAtCoords({ left: point.x, top: point.y });
  if (!at) return false;
  const { from, to } = view.state.selection;
  return at.pos >= from && at.pos <= to;
}
