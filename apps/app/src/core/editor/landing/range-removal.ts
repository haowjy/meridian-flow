/**
 * Takes a text selection out of the document without joining the blocks it
 * crosses. A textblock the range only reaches into keeps its unselected text
 * and its type; prose whitespace beside the removed text is trimmed. A block
 * the range covers entirely goes, and so do the containers that would be left
 * empty (a list item, a list). `deleteSelection` would merge the last block
 * into the first.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import { type Selection, TextSelection, type Transaction } from "@tiptap/pm/state";

import { isTable, isTableCell } from "./point-landing";

/** True when `selection` crosses textblocks, which is what this removes. */
export function crossesTextblocks(selection: Selection): boolean {
  return (
    selection instanceof TextSelection &&
    !selection.empty &&
    !(selection.$from.parent.isTextblock && selection.$from.sameParent(selection.$to))
  );
}

type Removal =
  | { kind: "text"; from: number; to: number }
  | {
      kind: "block";
      from: number;
      to: number;
      parent: PMNode;
      fromIndex: number;
      toIndex: number;
    };

export function removeRange(transaction: Transaction, from: number, to: number): void {
  const removals: Removal[] = [];
  transaction.doc.nodesBetween(from, to, (node, pos, parent, index) => {
    const end = pos + node.nodeSize;
    if (isTable(node) && from <= pos && to >= end) {
      addBlockRemoval(removals, node, pos, parent, index);
      return false;
    }
    if (
      node.isBlock &&
      !node.isTextblock &&
      !node.type.spec.tableRole &&
      coversBlockContent(node, pos, from, to)
    ) {
      addBlockRemoval(removals, node, pos, parent, index);
      return false;
    }
    if (node.isTextblock) {
      let start = Math.max(from, pos + 1);
      let stop = Math.min(to, end - 1);
      let whole =
        node.content.size === 0 ? from <= pos && to >= end : start <= pos + 1 && stop >= end - 1;
      if (!whole && start < stop && !node.type.spec.code) {
        if (stop === end - 1) {
          while (start > pos + 1 && /\s/u.test(transaction.doc.textBetween(start - 1, start)))
            start--;
        }
        if (start === pos + 1) {
          while (stop < end - 1 && /\s/u.test(transaction.doc.textBetween(stop, stop + 1))) stop++;
        }
        whole = start === pos + 1 && stop === end - 1;
      }
      if (whole) addBlockRemoval(removals, node, pos, parent, index);
      else if (start < stop) removals.push({ kind: "text", from: start, to: stop });
      return false;
    }
    if (node.isLeaf && pos >= from && end <= to)
      addBlockRemoval(removals, node, pos, parent, index);
    return !node.isLeaf;
  });
  // Last first, so each removal leaves the earlier positions alone.
  for (const removal of removals.sort((a, b) => removalStart(b) - removalStart(a))) {
    if (removal.kind === "text") transaction.delete(removal.from, removal.to);
    else removeBlocks(transaction, removal);
  }
}

function removalStart(removal: Removal): number {
  return removal.from;
}

function addBlockRemoval(
  removals: Removal[],
  node: PMNode,
  pos: number,
  parent: PMNode | null,
  index: number,
): void {
  if (!parent) return;
  const previous = removals.at(-1);
  if (previous?.kind !== "block" || previous.parent !== parent || previous.to !== pos) {
    removals.push({
      kind: "block",
      from: pos,
      to: pos + node.nodeSize,
      parent,
      fromIndex: index,
      toIndex: index + 1,
    });
    return;
  }
  previous.to = pos + node.nodeSize;
  previous.toIndex = index + 1;
}

function removeBlocks(
  transaction: Transaction,
  removal: Extract<Removal, { kind: "block" }>,
): void {
  if (removal.parent.canReplace(removal.fromIndex, removal.toIndex)) {
    transaction.delete(removal.from, removal.to);
    return;
  }
  let pos = removal.from;
  const positions: number[] = [];
  for (let index = removal.fromIndex; index < removal.toIndex; index++) {
    positions.push(pos);
    pos += removal.parent.child(index).nodeSize;
  }
  for (let index = positions.length - 1; index >= 0; index--)
    removeBlock(transaction, positions[index] as number);
}

function coversBlockContent(node: PMNode, pos: number, from: number, to: number): boolean {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  node.descendants((child, offset) => {
    if (!child.isLeaf) return true;
    first = Math.min(first, pos + 1 + offset);
    last = Math.max(last, pos + 1 + offset + child.nodeSize);
    return false;
  });
  return first !== Number.POSITIVE_INFINITY && from <= first && to >= last;
}

type RemovableChild = {
  from: number;
  to: number;
};

function removableChild(doc: PMNode, pos: number): RemovableChild | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const parent = $pos.node(depth);
    const index = $pos.index(depth);
    const from = $pos.posAtIndex(index, depth);
    const child = parent.child(index);
    if (parent.canReplace(index, index + 1)) {
      return { from, to: from + child.nodeSize };
    }
    if (isTableCell(parent)) break;
    if (parent.childCount > 1) break;
  }
  return null;
}

/**
 * Removes the block at `pos`, and the ancestors it would leave empty. A block
 * its parent can't do without (a list item's first paragraph, the document's
 * last block) keeps its place, emptied.
 */
function removeBlock(transaction: Transaction, pos: number): void {
  const removable = removableChild(transaction.doc, pos);
  if (removable) {
    transaction.delete(removable.from, removable.to);
    return;
  }
  const $pos = transaction.doc.resolve(pos);
  const block = $pos.nodeAfter;
  if (block?.isTextblock && block.content.size > 0)
    transaction.delete(pos + 1, pos + block.nodeSize - 1);
}
