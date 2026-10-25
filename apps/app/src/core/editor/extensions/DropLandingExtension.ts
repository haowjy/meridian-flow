/**
 * The drop door and its promise.
 *
 * Two plugins, one resolution (`../table-drop.ts`): a drop whose raw position
 * is table-structural lands inside the nearest cell or refuses,
 * and the dropcursor drawn during the drag asks the same question — so the
 * caret the writer sees during a drag over a table is exactly where the
 * content will stand. Everywhere else both plugins defer to ProseMirror's
 * stock resolution, unchanged.
 *
 * The cursor view is prosemirror-dropcursor's, carried here because its target
 * arithmetic is not pluggable: the stock plugin computes its own `dropPoint`,
 * which is the function that approves the illegal seam in the first place.
 * Replacing the display without replacing the landing (or the reverse) would
 * be a promise the drop betrays.
 */

import { Extension } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import { type NodeSelection, Plugin } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

import { seamDropTransaction, seamHostableSlice, tableDropDecision } from "../table-drop";
import { DropCaretView } from "./drop-caret";
import { draggingMeridianEntries } from "./reference-drop";

/**
 * The drag's source selection, when the drag carries a single node. ProseMirror
 * keeps it on `view.dragging` for its own drop handler but leaves it out of the
 * public type; without it a moved node's deletion would fall back to whatever
 * the document selection happens to be.
 */
function draggedNodeSelection(view: EditorView): NodeSelection | null {
  const dragging = view.dragging as { node?: NodeSelection } | null;
  return dragging?.node ?? null;
}

function dropLandingPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDrop(view, event, slice, moved) {
        // A file drop is the image door's (`images/ImageIngressExtension.ts`),
        // which routes its own landing through the same resolution.
        if (
          (event.dataTransfer && event.dataTransfer.files.length > 0) ||
          draggingMeridianEntries(event)
        )
          return false;
        const decision = tableDropDecision(view, { x: event.clientX, y: event.clientY });
        if (decision.kind === "default") return false;
        if (decision.kind === "refuse") return true;
        const transaction = seamDropTransaction(view.state, decision.pos, slice, {
          moved,
          node: draggedNodeSelection(view),
        });
        // A slice no cell can host: the drop is consumed and nothing moves,
        // which is the refusal the hidden dropcursor already showed.
        if (!transaction) return true;
        view.focus();
        view.dispatch(transaction);
        return true;
      },
    },
  });
}

/**
 * Where the dropcursor should draw for a drag at `(x, y)`, or null for no
 * cursor. The one place display and landing could disagree, so it asks the
 * landing's own resolution first.
 */
function dropCursorTarget(view: EditorView, event: DragEvent): number | null {
  if (draggingMeridianEntries(event)) return null;
  const { clientX: x, clientY: y } = event;
  const pos = view.posAtCoords({ left: x, top: y });
  if (!pos) return null;
  const inside = pos.inside >= 0 ? view.state.doc.nodeAt(pos.inside) : null;
  const disable = inside?.type.spec.disableDropCursor;
  const disabled = typeof disable === "function" ? disable(view, pos, event) : disable;
  if (disabled) return null;

  const slice: Slice | null = view.dragging?.slice ?? null;
  const decision = tableDropDecision(view, { x, y });
  if (decision.kind === "refuse") return null;
  if (decision.kind === "snap") {
    // The hostability probe IS the landing transaction, built and discarded:
    // the cursor may only promise what the drop can deliver.
    return seamHostableSlice(view.state, decision.pos, slice) ? decision.pos : null;
  }
  if (!slice) return pos.pos;
  return dropPoint(view.state.doc, pos.pos, slice) ?? pos.pos;
}

function dropCursorPlugin(): Plugin {
  return new Plugin({
    view: (editorView) => new DropCaretView(editorView, dropCursorTarget),
  });
}

export const DropLandingExtension = Extension.create({
  name: "meridianDropLanding",

  addProseMirrorPlugins() {
    return [dropLandingPlugin(), dropCursorPlugin()];
  },
});
