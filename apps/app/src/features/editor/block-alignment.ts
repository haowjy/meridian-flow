import type { Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, type Transaction } from "@tiptap/pm/state";

export type BlockAlignment = null | "center" | "right";

export type AlignableBlock = {
  node: PMNode;
  pos: number;
};

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

export function currentAlignableBlock(state: EditorState): AlignableBlock | null {
  return alignableBlocksInSelection(state)[0] ?? null;
}

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
  return node.type.spec.attrs !== undefined && "align" in node.type.spec.attrs;
}
