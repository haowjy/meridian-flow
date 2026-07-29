/** Resolves and updates the alignable blocks under the current selection. */

import type { Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, type Transaction } from "@tiptap/pm/state";

export type BlockAlignment = null | "center" | "right";

export type AlignableBlock = {
  node: PMNode;
  pos: number;
};

/**
 * Every block the selection touches that carries an `align` attribute, in
 * document order. A table counts as ONE block: alignment applies to the table
 * rather than to the paragraph inside a cell, so the walk stops there.
 */
export function alignableBlocksInSelection(state: EditorState): AlignableBlock[] {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    return isAlignable(selection.node) ? [{ node: selection.node, pos: selection.from }] : [];
  }

  const blocks: AlignableBlock[] = [];
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!isAlignable(node)) return true;
    blocks.push({ node, pos });
    return false;
  });
  return blocks;
}

/** The block a control reads its current alignment from. */
export function currentAlignableBlock(state: EditorState): AlignableBlock | null {
  return alignableBlocksInSelection(state)[0] ?? null;
}

/**
 * Aligns every block the selection touches, which is what a writer means by
 * selecting three paragraphs and pressing Center. Attribute-only markup leaves
 * node sizes alone, so an earlier write never moves a later position.
 */
export function alignSelectedBlocks(state: EditorState, align: BlockAlignment): Transaction | null {
  const targets = alignableBlocksInSelection(state);
  if (targets.length === 0) return null;

  const transaction = state.tr;
  for (const target of targets) {
    transaction.setNodeMarkup(
      target.pos,
      undefined,
      { ...target.node.attrs, align },
      target.node.marks,
    );
  }
  return transaction;
}

function isAlignable(node: PMNode): boolean {
  return (
    node.type.name === "paragraph" || node.type.name === "heading" || node.type.name === "table"
  );
}
