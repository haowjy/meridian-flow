/**
 * The changes one `BlockDiff` holds: hunks join into a change when only a short run of unchanged
 * words separates them (`CHANGE_MARGIN`), across paragraph breaks. A block the id pairing found moved
 * is a removal in one place and an addition in another, and both join one group, so taking a change
 * can never take half of a move.
 */
import { Dsu } from "./dsu.js";
import type { BlockDiff, Hunk } from "./hunks.js";
import { isBlockTok, isWordTok } from "./tokens.js";

/** Words of unchanged text that keep two hunks apart; a block start counts as one word. */
const CHANGE_MARGIN = 3;

export interface ChangeGroup {
  hunks: Hunk[];
  /** The group holds a moved block. */
  move: boolean;
}

/** The diff's changes, in draft order. */
export function changeGroups(diff: BlockDiff): ChangeGroup[] {
  const { hunks, base: B } = diff;
  const dsu = new Dsu(hunks.length);
  for (let i = 1; i < hunks.length; i++) {
    let words = 0;
    for (let p = hunks[i - 1].to; p < hunks[i].from && words < CHANGE_MARGIN; p++)
      if (isBlockTok(B.toks[p]) || isWordTok(B.toks[p])) words++;
    if (words < CHANGE_MARGIN) dsu.union(i - 1, i);
  }
  const moved = new Set<number>();
  for (const [a, b] of pairMoves(diff)) {
    dsu.union(a, b);
    moved.add(a);
    moved.add(b);
  }
  const byGroup = new Map<number, number[]>();
  hunks.forEach((_, i) => {
    const g = dsu.find(i);
    const list = byGroup.get(g);
    if (list) list.push(i);
    else byGroup.set(g, [i]);
  });
  return [...byGroup.values()]
    .sort(
      (x, y) =>
        Math.min(...x.map((i) => hunks[i].sfrom)) - Math.min(...y.map((i) => hunks[i].sfrom)),
    )
    .map((members) => ({
      hunks: members.map((i) => hunks[i]),
      move: members.some((i) => moved.has(i)),
    }));
}

/**
 * The hunk pairs that are one block moved: a block the id pairing found out of order is a removal
 * where it was and an addition where it is.
 */
function pairMoves(diff: BlockDiff): Array<[number, number]> {
  const { hunks, base: B, draft: D } = diff;
  // Hunks run in order on both sides, so the one holding a token is found by search.
  const holding = (tok: number, lo: (h: Hunk) => number, hi: (h: Hunk) => number) => {
    let [a, b] = [0, hunks.length];
    while (a < b) {
      const mid = (a + b) >> 1;
      if (hi(hunks[mid]) <= tok) a = mid + 1;
      else b = mid;
    }
    return a < hunks.length && lo(hunks[a]) <= tok ? a : -1;
  };
  const pairs: Array<[number, number]> = [];
  for (const [i, j] of diff.alignment.moves) {
    const removed = holding(
      B.starts[i],
      (h) => h.from,
      (h) => h.to,
    );
    const added = holding(
      D.starts[j],
      (h) => h.sfrom,
      (h) => h.sto,
    );
    if (removed >= 0 && added >= 0 && removed !== added) pairs.push([removed, added]);
  }
  return pairs;
}
