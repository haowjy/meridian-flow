import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";

/**
 * Children pairing by the block `id` attribute (ported from Meridian's patched y-tiptap,
 * `pairByBlockId` / `movedIds`). A block keeps its Loro container for life: a container is never
 * reused for a node with a different id, and a dragged block is the one re-created.
 */

/** One child of a list being reconciled: its block id (null for text and id-less nodes) and node name. */
export type ChildKey = { id: string | null; name: string | null };

/**
 * Pairs Loro and ProseMirror children in `[from, loroTo)` and `[from, pmTo)` that carry the same
 * block id and node name, keeping the largest set in the same order on both sides, so the fewest
 * blocks are replaced: a moved block is the one re-created, and the blocks it moved past keep
 * their containers. Returns the paired indices on each side.
 */
export function pairByBlockId(
  loro: readonly ChildKey[],
  pm: readonly ChildKey[],
  from: number,
  loroTo: number,
  pmTo: number,
  movedIds: ReadonlySet<string>,
): { loro: Set<number>; pm: Set<number> } {
  const pmIndex = new Map<string, number>();
  for (let j = from; j < pmTo; j++) {
    const id = pm[j].id;
    if (id !== null && !pmIndex.has(id)) pmIndex.set(id, j);
  }
  const candidates: [number, number][] = [];
  for (let i = from; i < loroTo; i++) {
    const id = loro[i].id;
    const j = id === null ? undefined : pmIndex.get(id);
    if (j !== undefined && loro[i].name === pm[j].name) candidates.push([i, j]);
  }
  // The heaviest run in the same order on both sides (a Fenwick tree of best runs by
  // ProseMirror index). A block this editor just moved weighs 1 and any other weighs more than
  // all of those together, so a block left in place always keeps its container and a dragged
  // run of any length is the one re-created.
  type Run = { weight: number; i: number; j: number; previous: Run | null };
  const stationary = candidates.length + 1;
  const size = pmTo - from;
  const tree: (Run | null)[] = new Array(size + 1).fill(null);
  const best = (j: number): Run | null => {
    let top: Run | null = null;
    for (let x = j - from; x > 0; x -= x & -x) {
      const run = tree[x];
      if (run !== null && (top === null || run.weight > top.weight)) top = run;
    }
    return top;
  };
  let last: Run | null = null;
  for (const [i, j] of candidates) {
    const before = best(j);
    const id = pm[j].id as string;
    const run: Run = {
      weight: (before === null ? 0 : before.weight) + (movedIds.has(id) ? 1 : stationary),
      i,
      j,
      previous: before,
    };
    for (let x = j - from + 1; x <= size; x += x & -x) {
      const held = tree[x];
      if (held === null || held.weight < run.weight) tree[x] = run;
    }
    if (last === null || run.weight > last.weight) last = run;
  }
  const loroPaired = new Set<number>();
  const pmPaired = new Set<number>();
  for (let run = last; run !== null; run = run.previous) {
    loroPaired.add(run.i);
    pmPaired.add(run.j);
  }
  return { loro: loroPaired, pm: pmPaired };
}

/**
 * The ids of blocks whose original occurrence these transactions deleted and put somewhere else
 * (a dragged block). A block a step only retypes or replaces in place, or a copy an earlier step
 * inserted, is not one.
 */
export function movedBlockIds(transactions: readonly Transaction[]): Set<string> {
  const moved = new Set<string>();
  for (const tr of transactions) {
    if (!tr.docChanged) continue;
    // Whether the block at `pos` before step `i` is one the transaction started with, not a copy
    // an earlier step inserted. Its content is traced back, not its opening token, which a
    // retype (`setNodeMarkup`) replaces while keeping the block.
    const original = (node: Node, pos: number, i: number) => {
      const leaf = node.isLeaf;
      let at = leaf ? pos : pos + 1;
      for (let k = i - 1; k >= 0; k--) {
        const result = tr.mapping.maps[k].invert().mapResult(at, 1);
        if (leaf ? result.deletedAfter : result.deletedAcross) return false;
        at = result.pos;
      }
      return true;
    };
    // Whether the block at `pos` before step `i` ends up replaced in place: its position lands
    // on a block with the same id.
    const inPlace = (node: Node, pos: number, i: number) => {
      let at = pos;
      for (let k = i; k < tr.mapping.maps.length; k++) at = tr.mapping.maps[k].map(at, -1);
      const now = tr.doc.nodeAt(at);
      return now !== null && now.attrs.id === node.attrs.id;
    };
    tr.steps.forEach((step, i) => {
      const before = tr.docs[i];
      step.getMap().forEach((oldStart, oldEnd) => {
        if (oldEnd <= oldStart) return;
        before.nodesBetween(oldStart, oldEnd, (node, pos) => {
          if (node.attrs.id == null || pos < oldStart || pos + node.nodeSize > oldEnd) return true;
          // A block replaced in place is an edit of it: what moved inside it can't be told.
          if (inPlace(node, pos, i)) return false;
          if (original(node, pos, i)) moved.add(String(node.attrs.id));
          return true;
        });
      });
    });
  }
  return moved;
}
