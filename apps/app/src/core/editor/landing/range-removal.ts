/**
 * Takes a text selection out of the document without joining the blocks it
 * crosses. A textblock the range only reaches into keeps its unselected text
 * and its type; a block the range covers entirely goes, and so do the
 * containers that would be left empty (a list item, a list). `deleteSelection`
 * would merge the last block into the first.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { Selection, Transaction } from "@tiptap/pm/state";

/** True when `selection` is one range that crosses textblocks, which is what this removes. */
export function crossesTextblocks(selection: Selection): boolean {
  return (
    selection.ranges.length === 1 &&
    !selection.empty &&
    !(selection.$from.parent.isTextblock && selection.$from.sameParent(selection.$to))
  );
}

type Removal = { kind: "text"; from: number; to: number } | { kind: "block"; pos: number };

export function removeRange(transaction: Transaction, from: number, to: number): void {
  const removals: Removal[] = [];
  transaction.doc.nodesBetween(from, to, (node: PMNode, pos: number) => {
    const end = pos + node.nodeSize;
    if (node.isTextblock) {
      const start = Math.max(from, pos + 1);
      const stop = Math.min(to, end - 1);
      const whole =
        node.content.size === 0 ? from <= pos && to >= end : start <= pos + 1 && stop >= end - 1;
      if (whole) removals.push({ kind: "block", pos });
      else if (start < stop) removals.push({ kind: "text", from: start, to: stop });
      return false;
    }
    if (node.isLeaf && pos >= from && end <= to) removals.push({ kind: "block", pos });
    return !node.isLeaf;
  });
  // Last first, so each removal leaves the earlier positions alone.
  for (const removal of removals.reverse()) {
    if (removal.kind === "text") transaction.delete(removal.from, removal.to);
    else removeBlock(transaction, removal.pos);
  }
}

/**
 * Removes the block at `pos`, and the ancestors it would leave empty. A block
 * its parent can't do without (a list item's first paragraph, the document's
 * last block) keeps its place, emptied.
 */
function removeBlock(transaction: Transaction, pos: number): void {
  const $pos = transaction.doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const parent = $pos.node(depth);
    const index = depth === $pos.depth ? $pos.index() : $pos.index(depth);
    const before = $pos.posAtIndex(index, depth);
    if (parent.canReplace(index, index + 1)) {
      transaction.delete(before, before + parent.child(index).nodeSize);
      return;
    }
    if (parent.childCount > 1) break;
  }
  const block = $pos.nodeAfter;
  if (block?.isTextblock && block.content.size > 0)
    transaction.delete(pos + 1, pos + block.nodeSize - 1);
}
