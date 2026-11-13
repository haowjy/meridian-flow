/**
 * List commands as attribute writes. A list is not a node: a block's `path`, `kind`, `marker`,
 * `start` and `loose` say which lists it sits in (`nest`, `@meridian/prosemirror-schema`), so
 * making, nesting and lifting an item changes attributes on the same elements and wraps nothing.
 */
import {
  type BlockFacts,
  extentOf,
  innermostListStep,
  nestNodes,
  pathOf,
  readPath,
} from "@meridian/prosemirror-schema";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";

export type ListKindName = "bullet" | "ordered";

/** Tab stops at this many list levels; the path is still read and written in full beyond it. */
export const MAX_LIST_DEPTH = 8;

/** The sibling blocks a selection reaches: the children of one container, read together. */
type Sequence = {
  blocks: ProseMirrorNode[];
  /** Position of each block. */
  positions: number[];
  facts: BlockFacts[];
  /** Index range of the blocks the selection touches. */
  from: number;
  to: number;
};

/** The blocks the selection touches, as siblings under their nearest shared container. */
export function selectedSequence(selection: Transaction["selection"]): Sequence {
  const { $from, $to } = selection;
  const textDepth =
    selection instanceof NodeSelection || !$from.parent.isTextblock ? $from.depth + 1 : $from.depth;
  const depth = Math.max(0, Math.min($from.sharedDepth($to.pos), textDepth - 1));
  const container = $from.node(depth);
  const blocks: ProseMirrorNode[] = [];
  const positions: number[] = [];
  let at = $from.start(depth);
  container.forEach((child) => {
    blocks.push(child);
    positions.push(at);
    at += child.nodeSize;
  });
  const last = selection instanceof NodeSelection ? $from.index(depth) + 1 : $to.indexAfter(depth);
  return {
    blocks,
    positions,
    facts: nestNodes(blocks),
    from: $from.index(depth),
    to: Math.max(last, $from.index(depth) + 1),
  };
}

function write(tr: Transaction, sequence: Sequence, index: number, attrs: Record<string, unknown>) {
  const block = sequence.blocks[index];
  tr.setNodeMarkup(sequence.positions[index], undefined, { ...block.attrs, ...attrs });
}

/** Where the item that block `index` belongs to starts, at that block's innermost list level. */
function itemStart(facts: readonly BlockFacts[], index: number): number {
  const level = innermostListStep(facts[index].steps);
  let start = index;
  while (start > 0) {
    const step = facts[start].steps[level];
    if (!step || step.startsItem || step.opens) break;
    start--;
  }
  return start;
}

/** Item starts of the selected blocks, each once, with blocks outside any list left out. */
function selectedItems(sequence: Sequence): number[] {
  const starts = new Set<number>();
  for (let i = sequence.from; i < sequence.to; i++) {
    if (innermostListStep(sequence.facts[i].steps) >= 0) starts.add(itemStart(sequence.facts, i));
  }
  return [...starts];
}

/** The kind of the innermost list every selected block sits in, or null when they differ or one is in none. */
export function selectionListKind(sequence: Sequence): ListKindName | null {
  let kind: ListKindName | null = null;
  for (let i = sequence.from; i < sequence.to; i++) {
    const level = innermostListStep(sequence.facts[i].steps);
    if (level < 0) return null;
    const own = sequence.facts[i].steps[level].list?.kind ?? "bullet";
    if (kind !== null && kind !== own) return null;
    kind = own;
  }
  return kind;
}

/** Makes every selected block an item of this kind, or changes the kind of the items it already is. */
export function setList(tr: Transaction, kind: ListKindName): boolean {
  const sequence = selectedSequence(tr.selection);
  let changed = false;
  for (let i = sequence.from; i < sequence.to; i++) {
    const facts = sequence.facts[i];
    const level = innermostListStep(facts.steps);
    const own = { kind: kind === "ordered" ? "ordered" : null };
    if (level < 0) {
      const steps = readPath(sequence.blocks[i].attrs.path);
      steps.push({ type: "list", fresh: false });
      // A list item holds body text, so wrapping a heading in one clears its level.
      const level0 = sequence.blocks[i].type.name === "paragraph" ? { level: null } : {};
      write(tr, sequence, i, { path: pathOf(steps), marker: "item", ...own, ...level0 });
      changed = true;
    } else if (facts.steps[level].startsItem) {
      write(tr, sequence, i, own);
      changed = true;
    }
  }
  return changed;
}

/** Returns the selected items' blocks to body text, however deep they sit. */
export function unsetList(tr: Transaction): boolean {
  let changed = false;
  // Each pass lifts the selected items one level, so the depth bounds the loop.
  for (let guard = 64; guard > 0 && outdent(tr); guard--) changed = true;
  return changed;
}

/** One more list level for each selected item and what is under it. */
export function indent(tr: Transaction): boolean {
  const sequence = selectedSequence(tr.selection);
  let changed = false;
  for (const start of selectedItems(sequence)) {
    const level = innermostListStep(sequence.facts[start].steps);
    const step = sequence.facts[start].steps[level];
    // Nothing above to nest under: the first item of its list.
    if (!step.startsItem || step.opens) continue;
    const depth = sequence.facts[start].steps.filter((s) => s.type === "list").length;
    if (depth >= MAX_LIST_DEPTH) continue;
    const [from, to] = extentOf(sequence.facts, start);
    for (let i = from; i < to; i++) {
      const steps = readPath(sequence.blocks[i].attrs.path);
      steps.splice(level + 1, 0, { type: "list", fresh: false });
      write(tr, sequence, i, { path: pathOf(steps) });
    }
    changed = true;
  }
  return changed;
}

/** One list level fewer for each selected item and what is under it; the last level returns the blocks to body text. */
export function outdent(tr: Transaction): boolean {
  const sequence = selectedSequence(tr.selection);
  let changed = false;
  for (const start of selectedItems(sequence)) {
    const level = innermostListStep(sequence.facts[start].steps);
    const [from, to] = extentOf(sequence.facts, start);
    for (let i = from; i < to; i++) {
      const steps = readPath(sequence.blocks[i].attrs.path);
      steps.splice(level, 1);
      const path = pathOf(steps);
      const stillListed = steps.some((s) => s.type === "list");
      write(
        tr,
        sequence,
        i,
        stillListed ? { path } : { path, kind: null, marker: null, start: null, loose: null },
      );
    }
    changed = true;
  }
  return changed;
}
