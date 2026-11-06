/**
 * The press router for a table cell's INERT interior.
 *
 * A press on a cell's own surface — the padding beside a fence, the seam
 * between two blocks, the space around a rendered object, an opaque-only
 * cell's margins — has no text under it, and the browser's answer to such a
 * press is a hunt for the nearest editable position, which beside a border is
 * the NEIGHBOURING cell (the S6 probe watched exactly that teleport). The
 * landing walk is started from the pressed cell, so the answer never leaves
 * it; this plugin is the router that gives `landing/press.ts` the press and the
 * cell. A `td` that is not a document cell (a foreign one in a node view) is
 * declined.
 *
 * It claims nothing else. A press on writer text, on a block's own DOM, or on
 * an object's body keeps its native owner (ProseMirror's caret machinery,
 * ObjectPhysics's press selection). The claim test is the event target being
 * the cell element ITSELF: only the cell's padding and its between-block
 * seams render as the cell's own DOM, so target identity is what separates
 * inert from alive.
 */

import type { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { type Child, isTableCell } from "./point-landing";
import { pressSelection } from "./press";
import { viewGeometry } from "./view-geometry";

/** The cell node `dom` renders, or null when `dom` is not a cell's own DOM. */
function cellContainerAtDOM(view: EditorView, dom: Element): Child | null {
  let inside: number;
  try {
    inside = view.posAtDOM(dom, 0);
  } catch {
    return null;
  }
  if (inside < 1 || inside > view.state.doc.content.size) return null;
  const $inside = view.state.doc.resolve(inside);
  if (!isTableCell($inside.parent)) return null;
  return { node: $inside.parent, pos: $inside.before($inside.depth) };
}

/**
 * Registered AFTER prosemirror-tables' own handlers (the spread order in
 * `extensions/meridian-extensions.ts` is the contract): a column-resize press
 * arrives here already claimed and default-prevented, and the cell-sweep
 * drag's mousemove listeners are armed before this claim runs — so sweeping
 * a selection out of a padding press still becomes a `CellSelection`.
 */
export function cellInteriorPressPlugin(editor: Editor): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          // Primary presses only: the context-claim ladder owns the rest.
          if (event.button !== 0 || event.defaultPrevented || !view.editable) return false;
          const target = event.target;
          if (!(target instanceof Element) || !target.matches("td, th")) return false;
          if (!view.dom.contains(target)) return false;
          const cell = cellContainerAtDOM(view, target);
          if (!cell) return false;
          const selection = pressSelection(
            view.state,
            { x: event.clientX, y: event.clientY },
            viewGeometry(view, editor),
            cell,
          );
          // No selection is claimed too: the browser's default for this press
          // is the cross-border caret hunt, and standing still is the answer
          // for a cell with no visible caret to offer.
          event.preventDefault();
          if (selection) view.dispatch(view.state.tr.setSelection(selection));
          view.focus();
          return true;
        },
      },
    },
  });
}
