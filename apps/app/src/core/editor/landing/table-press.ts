import type { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

import { objectTextSelectionTransaction } from "../objects/object-selection";
import { type Child, isTableCell } from "./point-landing";
import { pressSelection } from "./press";
import { viewGeometry } from "./view-geometry";

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
export function tablePressPlugin(editor: Editor): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0 || event.defaultPrevented || !view.editable) return false;
          const target = event.target;
          const cell =
            target instanceof Element && target.matches("td, th") && view.dom.contains(target)
              ? cellContainerAtDOM(view, target)
              : null;
          if (!cell) {
            // Tables already claimed grid extensions. Only native fallthrough
            // restores the range hidden by the typing caret projection.
            if (event.shiftKey && view.state.selection instanceof CellSelection) {
              const transaction = objectTextSelectionTransaction(view.state, 1);
              if (transaction) view.dispatch(transaction);
            }
            return false;
          }
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
