/** Resolves and updates the single alignable block at the selection head. */

import type { Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, type Transaction } from "@tiptap/pm/state";

export type BlockAlignment = null | "center" | "right";

export type AlignableBlock = {
  node: PMNode;
  pos: number;
};

export function currentAlignableBlock(state: EditorState): AlignableBlock | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && isAlignable(selection.node)) {
    return { node: selection.node, pos: selection.from };
  }

  const { $head } = selection;
  // A cell's paragraph is structurally nearer, but block alignment applies to
  // the containing table rather than to one cell's internal paragraph.
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const node = $head.node(depth);
    if (node.type.name === "table") return { node, pos: $head.before(depth) };
  }
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const node = $head.node(depth);
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      return { node, pos: $head.before(depth) };
    }
  }
  return null;
}

export function setCurrentBlockAlignment(
  state: EditorState,
  align: BlockAlignment,
): Transaction | null {
  const target = currentAlignableBlock(state);
  if (!target) return null;
  return state.tr.setNodeMarkup(
    target.pos,
    undefined,
    { ...target.node.attrs, align },
    target.node.marks,
  );
}

function isAlignable(node: PMNode): boolean {
  return (
    node.type.name === "paragraph" || node.type.name === "heading" || node.type.name === "table"
  );
}
