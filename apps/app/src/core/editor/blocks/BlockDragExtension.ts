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
 *   because a remote write is one replacement over everything that differs
 *   (the whole document when that fails), and a mapped number inside it would
 *   report the grabbed block deleted.
 *
 * Nothing here touches the document. The transactions carry meta only, so no
 * step reaches the room and no undo entry appears for picking a paragraph up.
 */

import { extentOf, nestNodes } from "@meridian/prosemirror-schema";
import { type Editor, Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { carryAnchor, holdBlock, type NodeHold, resolveBlockHold } from "../anchors";

const BLOCK_DRAG_NAME = "meridianBlockDrag";

export const BLOCK_LIFTED_CLASS = "meridian-block-lifted";

type BlockDragState = {
  hold: NodeHold;
  lifted: boolean;
};

type BlockDragMessage = BlockDragState | null;

const blockDragPluginKey = new PluginKey<BlockDragState | null>(BLOCK_DRAG_NAME);

export function beginBlockDrag(editor: Editor, pos: number): void {
  const hold = holdBlock(editor.state, pos);
  if (hold) dispatchBlockDrag(editor, { hold, lifted: false });
}

export function liftBlockDrag(editor: Editor): void {
  const current = blockDragPluginKey.getState(editor.state);
  if (!current || current.lifted) return;
  dispatchBlockDrag(editor, { ...current, lifted: true });
}

export function endBlockDrag(editor: Editor): void {
  if (!blockDragPluginKey.getState(editor.state)) return;
  dispatchBlockDrag(editor, null);
}

/**
 * Where the held block is now, or null when no gesture has one.
 *
 * Resolved on read rather than in the plugin's `apply`: the Loro binding this
 * asks is the one belonging to the state in hand, and inside `apply` the
 * binding may still be describing the document the transaction replaced.
 */
export function draggedBlockPos(state: EditorState): number | null {
  const held = blockDragPluginKey.getState(state);
  return held ? (resolveBlockHold(state, held.hold)?.from ?? null) : null;
}

export const BlockDragExtension = Extension.create({
  name: BLOCK_DRAG_NAME,
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
            return carried ? { ...current, hold: carried } : null;
          },
        },

        props: {
          decorations(state) {
            const held = blockDragPluginKey.getState(state);
            if (!held?.lifted) return null;
            const pos = draggedBlockPos(state);
            if (pos === null || !state.doc.nodeAt(pos)) return null;
            const index = state.doc.resolve(pos).index(0);
            const [from, to] = extentOf(nestNodes(state.doc.content.content), index);
            const decorations: Decoration[] = [];
            let at = pos;
            for (let i = from; i < to; i++) {
              const node = state.doc.child(i);
              decorations.push(
                Decoration.node(at, at + node.nodeSize, { class: BLOCK_LIFTED_CLASS }),
              );
              at += node.nodeSize;
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

function dispatchBlockDrag(editor: Editor, message: BlockDragMessage): void {
  if (editor.isDestroyed) return;
  const transaction: Transaction = editor.state.tr.setMeta(blockDragPluginKey, message);
  transaction.setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
}
