/**
 * The document's memory of a block being dragged: which one the pointer has
 * hold of, and whether it has been lifted yet.
 *
 * The block surface could not keep this itself. Two things make it the
 * document's business rather than React's:
 *
 * - **The manuscript has to show it.** A lifted block reads at half opacity
 *   (§5.8), and the only way to style a node ProseMirror renders is a
 *   decoration. Setting an attribute on the element by hand does not survive:
 *   ProseMirror's DOM observer treats an unexpected attribute change as
 *   corruption and re-renders the node without it.
 * - **The position has to survive the drag.** A peer's edit or an AI write can
 *   land while the pointer is down (law 9 — nothing gates a write), and the
 *   block the writer grabbed has to still be the block that lands. One held
 *   position, here, rather than one per consumer — and an `EditorAnchor`,
 *   because a remote write replaces the whole document and a mapped number
 *   would report the grabbed block deleted every time.
 *
 * Nothing here touches the document. The transactions carry meta only, so no
 * step reaches Yjs and no undo entry appears for picking a paragraph up.
 */

import { type Editor, Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { anchorRange, carryAnchor, type EditorAnchor, resolveAnchorIn } from "../anchors";

const BLOCK_DRAG_NAME = "meridianBlockDrag";

/** Marks the lifted block for `editor.css`; the surface owns nothing here. */
export const BLOCK_LIFTED_CLASS = "meridian-block-lifted";

type BlockDragState = {
  /**
   * The block under the pointer, held as its two seams. Both of them land on
   * the same seam once the block is gone, which is the only way to tell "a
   * peer deleted what I am holding" from "a peer wrote above it": a remote
   * write replaces the whole document, so the mapping calls everything
   * deleted and a single position resolves to the gap the block left.
   */
  hold: EditorAnchor;
  /** False while the press might still turn out to be a click. */
  lifted: boolean;
};

type BlockDragMessage = BlockDragState | null;

const blockDragPluginKey = new PluginKey<BlockDragState | null>(BLOCK_DRAG_NAME);

/**
 * Take hold of the block at `pos`. Nothing is lifted yet: a press that never
 * travels is a click, and a paragraph that faded for it would be a flicker.
 */
export function beginBlockDrag(editor: Editor, pos: number): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const hold = anchorRange(editor.state, { from: pos, to: pos + node.nodeSize });
  dispatchBlockDrag(editor, { hold, lifted: false });
}

/** The press became a drag. The block lifts. */
export function liftBlockDrag(editor: Editor): void {
  const current = blockDragPluginKey.getState(editor.state);
  if (!current || current.lifted) return;
  dispatchBlockDrag(editor, { ...current, lifted: true });
}

/** Let go, dropped or cancelled. */
export function endBlockDrag(editor: Editor): void {
  if (!blockDragPluginKey.getState(editor.state)) return;
  dispatchBlockDrag(editor, null);
}

/**
 * Where the held block is now, or null when no gesture has one.
 *
 * Resolved on read rather than in the plugin's `apply`: the Yjs binding this
 * asks is the one belonging to the state in hand, and inside `apply` the
 * binding may still be describing the document the transaction replaced.
 */
export function draggedBlockPos(state: EditorState): number | null {
  const held = blockDragPluginKey.getState(state);
  const at = held && resolveAnchorIn(state, held.hold);
  return at && at.to > at.from ? at.from : null;
}

export const BlockDragExtension = Extension.create({
  name: BLOCK_DRAG_NAME,
  // Below the chrome kernel and object physics: this holds no keys and claims
  // nothing, it only decorates.
  priority: 1030,

  addProseMirrorPlugins() {
    return [
      new Plugin<BlockDragState | null>({
        key: blockDragPluginKey,

        state: {
          init: () => null,
          apply(transaction, current) {
            const message = transaction.getMeta(blockDragPluginKey) as BlockDragMessage | undefined;
            if (message !== undefined) return message;
            if (!current) return null;
            const carried = carryAnchor(current.hold, transaction.mapping);
            // A deleted block leaves nothing to hold — which only the mapping
            // of a local edit can say, and only for an editor with no shared
            // document behind it.
            return carried ? { ...current, hold: carried } : null;
          },
        },

        props: {
          decorations(state) {
            const held = blockDragPluginKey.getState(state);
            if (!held?.lifted) return null;
            const pos = draggedBlockPos(state);
            const node = pos === null ? null : state.doc.nodeAt(pos);
            if (pos === null || !node) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + node.nodeSize, { class: BLOCK_LIFTED_CLASS }),
            ]);
          },
        },
      }),
    ];
  },
});

function dispatchBlockDrag(editor: Editor, message: BlockDragMessage): void {
  if (editor.isDestroyed) return;
  const transaction: Transaction = editor.state.tr.setMeta(blockDragPluginKey, message);
  // Nothing about the document changed, so nothing downstream should think it
  // did: no history entry, no scroll, no selection move.
  transaction.setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
}
