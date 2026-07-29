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
 *   block the writer grabbed has to still be the block that lands. One mapped
 *   position, here, rather than one per consumer.
 *
 * Nothing here touches the document. The transactions carry meta only, so no
 * step reaches Yjs and no undo entry appears for picking a paragraph up.
 */

import { type Editor, Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const BLOCK_DRAG_NAME = "meridianBlockDrag";

/** Marks the lifted block for `editor.css`; the surface owns nothing here. */
export const BLOCK_LIFTED_CLASS = "meridian-block-lifted";

type BlockDragState = {
  /** Position before the block under the pointer, mapped through every edit. */
  pos: number;
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
  dispatchBlockDrag(editor, { pos, lifted: false });
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

/** Where the held block is now, or null when no gesture has one. */
export function draggedBlockPos(state: EditorState): number | null {
  return blockDragPluginKey.getState(state)?.pos ?? null;
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
            // A deleted block leaves nothing to hold: `-1` is how the mapping
            // reports that its position was inside a range that went away.
            const mapped = transaction.mapping.mapResult(current.pos);
            return mapped.deleted ? null : { ...current, pos: mapped.pos };
          },
        },

        props: {
          decorations(state) {
            const held = blockDragPluginKey.getState(state);
            if (!held?.lifted) return null;
            const node = state.doc.nodeAt(held.pos);
            if (!node) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(held.pos, held.pos + node.nodeSize, {
                class: BLOCK_LIFTED_CLASS,
              }),
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
