/**
 * Takes a text selection out of the document without joining the blocks it
 * crosses. A textblock the range only reaches into keeps its unselected text
 * and its type; a block the range covers entirely goes, and so do the
 * containers that would be left empty (a list item, a list). `deleteSelection`
 * would merge the last block into the first.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import { type Selection, TextSelection, type Transaction } from "@tiptap/pm/state";

import { isTable, isTableCell } from "./point-landing";

/** True when `selection` is one range that crosses textblocks, which is what this removes. */
export function crossesTextblocks(selection: Selection): boolean {
  return (
    selection instanceof TextSelection &&
    selection.ranges.length === 1 &&
    !selection.empty &&
    !(selection.$from.parent.isTextblock && selection.$from.sameParent(selection.$to))
  );
}

type Removal =
  | { kind: "text"; from: number; to: number }
  | { kind: "blocks"; from: number; to: number }
  | { kind: "block"; pos: number };

export function removeRange(transaction: Transaction, from: number, to: number): void {
  const removals: Removal[] = [];
  const wholeBlocks: number[] = [];
  transaction.doc.nodesBetween(from, to, (node: PMNode, pos: number) => {
    const end = pos + node.nodeSize;
    if (isTable(node) && from <= pos && to >= end) {
      wholeBlocks.push(pos);
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
      if (whole) wholeBlocks.push(pos);
      else if (start < stop) removals.push({ kind: "text", from: start, to: stop });
      return false;
    }
    if (node.isLeaf && pos >= from && end <= to) wholeBlocks.push(pos);
    return !node.isLeaf;
  });
  removals.push(...mergedWholeBlocks(transaction.doc, wholeBlocks));
  // Last first, so each removal leaves the earlier positions alone.
  for (const removal of removals.sort((a, b) => removalStart(b) - removalStart(a))) {
    if (removal.kind === "text" || removal.kind === "blocks")
      transaction.delete(removal.from, removal.to);
    else removeBlock(transaction, removal.pos);
  }
}

function removalStart(removal: Removal): number {
  return removal.kind === "block" ? removal.pos : removal.from;
}

type RemovableChild = {
  pos: number;
  parent: PMNode;
  index: number;
  from: number;
  to: number;
};

/** Collapses sibling blocks into one step without emptying a required container. */
function mergedWholeBlocks(doc: PMNode, positions: number[]): Removal[] {
  const found = positions.map((pos) => removableChild(doc, pos));
  const removals: Removal[] = [];
  for (let at = 0; at < found.length; ) {
    const first = found[at];
    if (!first) {
      removals.push({ kind: "block", pos: positions[at] as number });
      at++;
      continue;
    }
    const run = [first];
    let next = at + 1;
    while (next < found.length) {
      const candidate = found[next];
      const previous = run.at(-1) as RemovableChild;
      if (
        !candidate ||
        candidate.parent !== first.parent ||
        candidate.index !== previous.index + 1 ||
        candidate.from !== previous.to
      )
        break;
      run.push(candidate);
      next++;
    }
    const endIndex = (run.at(-1) as RemovableChild).index + 1;
    if (run.length > 1 && first.parent.canReplace(first.index, endIndex)) {
      removals.push({ kind: "blocks", from: first.from, to: (run.at(-1) as RemovableChild).to });
    } else if (run.length > 2 && first.parent.canReplace(first.index + 1, endIndex)) {
      removals.push(
        { kind: "block", pos: first.pos },
        {
          kind: "blocks",
          from: (run[1] as RemovableChild).from,
          to: (run.at(-1) as RemovableChild).to,
        },
      );
    } else {
      removals.push(...run.map(({ pos }) => ({ kind: "block" as const, pos })));
    }
    at = next;
  }
  return removals;
}

function removableChild(doc: PMNode, pos: number): RemovableChild | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const parent = $pos.node(depth);
    const index = $pos.index(depth);
    const from = $pos.posAtIndex(index, depth);
    const child = parent.child(index);
    if (parent.canReplace(index, index + 1)) {
      return { pos, parent, index, from, to: from + child.nodeSize };
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
  const $pos = transaction.doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const parent = $pos.node(depth);
    const index = $pos.index(depth);
    const before = $pos.posAtIndex(index, depth);
    if (parent.canReplace(index, index + 1)) {
      transaction.delete(before, before + parent.child(index).nodeSize);
      return;
    }
    if (isTableCell(parent)) break;
    if (parent.childCount > 1) break;
  }
  const block = $pos.nodeAfter;
  if (block?.isTextblock && block.content.size > 0)
    transaction.delete(pos + 1, pos + block.nodeSize - 1);
}
