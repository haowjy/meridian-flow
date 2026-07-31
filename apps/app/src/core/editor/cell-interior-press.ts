/**
 * The press router for a table cell's INERT interior.
 *
 * A press on a cell's own surface — the padding beside a fence, the seam
 * between two blocks, the space around a rendered object, an opaque-only
 * cell's margins — has no text under it, and the browser's answer to such a
 * press is a hunt for the nearest editable position, which beside a border is
 * the NEIGHBOURING cell (the S6 probe watched exactly that teleport). Where
 * such a press belongs is `pointer-boundary.ts`'s §4 policy — an answer never
 * leaves the pressed cell — and this plugin is only the router that gives the
 * policy the press.
 *
 * It claims nothing else. A press on writer text, on a block's own DOM, or on
 * an object's body keeps its native owner (ProseMirror's caret machinery,
 * ObjectPhysics's press selection). The claim test is the event target being
 * the cell element ITSELF: only the cell's padding and its between-block
 * seams render as the cell's own DOM, so target identity is what separates
 * inert from alive.
 */

import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { type PointerBoundaryContainer, pointerBoundaryDecision } from "./pointer-boundary";

/** The cell node `dom` renders, or null when `dom` is not a cell's own DOM. */
function cellContainerAtDOM(view: EditorView, dom: Element): PointerBoundaryContainer | null {
  let inside: number;
  try {
    inside = view.posAtDOM(dom, 0);
  } catch {
    return null;
  }
  if (inside < 1 || inside > view.state.doc.content.size) return null;
  const $inside = view.state.doc.resolve(inside);
  const role = $inside.parent.type.spec.tableRole;
  if (role !== "cell" && role !== "header_cell") return null;
  return { node: $inside.parent, pos: $inside.before($inside.depth) };
}

/**
 * Registered AFTER prosemirror-tables' own handlers (the spread order in
 * `extensions/meridian-extensions.ts` is the contract): a column-resize press
 * arrives here already claimed and default-prevented, and the cell-sweep
 * drag's mousemove listeners are armed before this claim runs — so sweeping
 * a selection out of a padding press still becomes a `CellSelection`.
 */
export function cellInteriorPressPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          // Primary presses only: the context-claim ladder owns the rest.
          if (event.button !== 0 || event.defaultPrevented || !view.editable) return false;
          const target = event.target;
          if (!(target instanceof Element) || !target.matches("td, th")) return false;
          if (!view.dom.contains(target)) return false;
          const container = cellContainerAtDOM(view, target);
          if (!container) return false;

          const decision = pointerBoundaryDecision(view, event.clientX, event.clientY, container);
          // A decline is claimed too: the browser's default for this press is
          // the cross-border caret hunt, and standing still is the policy's
          // answer for a cell with no visible caret to offer.
          event.preventDefault();
          if (decision.kind === "place") {
            view.dispatch(view.state.tr.setSelection(decision.selection));
          }
          view.focus();
          return true;
        },
      },
    },
  });
}
