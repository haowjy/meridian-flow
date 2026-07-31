/**
 * When a right-click inside a plain code fence opens the fence's own menu.
 *
 * The ladder's floor, for the one context the formatting menu deliberately
 * does not own: a fence's verbs are its language, its source, and its shape,
 * and law 4 gives the deepest context the surface. Before the human ruling of
 * 2026-07-29 this right-click fell through to the browser; now it opens the
 * same list the ⋮ chip carries.
 *
 * Pure over the claim target, so the split matrix is testable without a
 * pointer. The kernel's resolver has already named the fence and its position;
 * nothing here walks the DOM.
 */

import type { Editor } from "@tiptap/core";

import {
  type ContextClaimTarget,
  getEditorChrome,
  isEditorChromeElement,
} from "@/core/editor/chrome";

/**
 * The document position of the fence the pointer is in, or null when this rung
 * declines.
 *
 * A rendered mermaid fence answers `object` rather than `source-block` and is
 * claimed further up the ladder — there is no inside to point at once the node
 * view draws a diagram.
 *
 * Read-only declines like every other claiming rung: the trade is the browser's
 * menu for the editor's verbs, and a fence nobody may change has none to offer
 * that the browser's own menu does not already have.
 */
export function fenceUnderPointer(editor: Editor, target: ContextClaimTarget): number | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  if (target.context.owner !== "source-block" || target.context.pos === null) return null;
  // The chip cluster is chrome standing inside the fence's own corner, and it
  // is its own door: claiming here would open a second menu over the first.
  const chrome = getEditorChrome(editor);
  if (chrome && isEditorChromeElement(chrome, target.element)) return null;
  return target.context.pos;
}
