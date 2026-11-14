/**
 * Paragraph order for the content merge. Takes each side's block correspondence with the base
 * (equal, edited in place, or moved), decides one paragraph order for the three documents, and lays
 * each out in it, so the token merge afterwards sees edits and no moves.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { Correspondence } from "../diff/correspond.js";
import type { Side } from "../diff/tokens.js";

/**
 * The blocks of `blocks` a side moved: those outside its longest run still in base order. `favored`
 * blocks tip a tie, so an adjacent swap (which moves either paragraph) is read as the two sides
 * moving different paragraphs, which leaves nothing to contest.
 */
function movedBlocks(blocks: number[], partner: Int32Array, favored: Set<number>): Set<number> {
  const seq = [...blocks].sort((a, b) => partner[a] - partner[b]);
  const weight = seq.map((x) => (favored.has(x) ? 1.001 : 1));
  const best = new Float64Array(seq.length);
  const prev = new Int32Array(seq.length).fill(-1);
  let top = -1;
  for (let i = 0; i < seq.length; i++) {
    best[i] = weight[i];
    for (let j = 0; j < i; j++)
      if (seq[j] < seq[i] && best[j] + weight[i] > best[i]) {
        best[i] = best[j] + weight[i];
        prev[i] = j;
      }
    if (top < 0 || best[i] > best[top]) top = i;
  }
  const inRun = new Set<number>();
  for (let i = top; i >= 0; i = prev[i]) inRun.add(seq[i]);
  return new Set(seq.filter((x) => !inRun.has(x)));
}

/** The base block that comes before `block` in the side, among `blocks`; -1 for none. */
function predecessorOf(block: number, blocks: number[], partner: Int32Array): number {
  let pred = -1;
  for (const y of blocks)
    if (partner[y] < partner[block] && (pred < 0 || partner[y] > partner[pred])) pred = y;
  return pred;
}

export type OrderMerge =
  | {
      reordered: false;
      cyclic: false;
      contested: number[];
      inLive: Int32Array;
      inDraft: Int32Array;
    }
  | {
      reordered: true;
      cyclic: boolean;
      contested: number[];
      /** Base block indices in the merged order. */
      baseOrder: number[];
      /** Live's and the draft's blocks laid out in `baseOrder`. */
      live: PMNode[];
      liveOrder: number[];
      draftOrder: number[];
      inLive: Int32Array;
      inDraft: Int32Array;
      draft: PMNode[];
    };

interface Placement {
  order: number[];
  cyclic: boolean;
  contested: number[];
}

/**
 * One order for the blocks both sides kept: each pair's order comes from whichever side changed it
 * (the draft if both did). Blocks one side removed then go after their predecessor on the side that
 * kept them.
 */
function placeBlocks(kept: number[], inLive: Int32Array, inDraft: Int32Array): Placement {
  const both = kept.filter((i) => inLive[i] >= 0 && inDraft[i] >= 0);
  // A paragraph both sides moved to different places is contested: the draft's place wins for
  // every pair involving it, and the move is reported.
  const draftMoved = movedBlocks(both, inDraft, movedBlocks(both, inLive, new Set()));
  const liveMoved = movedBlocks(both, inLive, draftMoved);
  const contested: number[] = [];
  for (const x of draftMoved)
    if (liveMoved.has(x) && predecessorOf(x, both, inLive) !== predecessorOf(x, both, inDraft))
      contested.push(x);

  const before = (x: number, y: number): boolean => {
    const inBase = x < y;
    const inLiveOrder = inLive[x] < inLive[y];
    const inDraftOrder = inDraft[x] < inDraft[y];
    if (contested.includes(x) || contested.includes(y)) return inDraftOrder;
    return inLiveOrder === inBase
      ? inDraftOrder
      : inDraftOrder === inBase
        ? inLiveOrder
        : inDraftOrder;
  };
  const scored = both
    .map((x) => [x, both.reduce((n, y) => n + (y !== x && before(y, x) ? 1 : 0), 0)] as const)
    .sort((a, b) => a[1] - b[1]);
  // Every score distinct and consecutive means the pairwise orders form one consistent sequence.
  const cyclic = scored.some(([, score], k) => score !== k);
  const order = cyclic ? [...both].sort((a, b) => inDraft[a] - inDraft[b]) : scored.map(([x]) => x);

  const place = (block: number, partner: Int32Array) => {
    let prev = -1;
    for (const x of order)
      if (
        partner[x] >= 0 &&
        partner[x] < partner[block] &&
        (prev < 0 || partner[x] > partner[prev])
      )
        prev = x;
    let at = prev < 0 ? 0 : order.indexOf(prev) + 1;
    // Skip blocks this side doesn't have that come before it in the base.
    while (at < order.length && partner[order[at]] < 0 && order[at] < block) at++;
    order.splice(at, 0, block);
  };
  for (const i of kept.filter((x) => inLive[x] < 0).sort((a, b) => inDraft[a] - inDraft[b]))
    place(i, inDraft);
  for (const i of kept.filter((x) => inDraft[x] < 0).sort((a, b) => inLive[a] - inLive[b]))
    place(i, inLive);
  return { order, cyclic, contested };
}

/** Blocks both sides removed keep their base neighbour, so a merge on both sides still aligns. */
function withRemovedBlocks(
  order: number[],
  baseCount: number,
  inLive: Int32Array,
  inDraft: Int32Array,
) {
  const out = [...order];
  for (let i = 0; i < baseCount; i++) {
    if (inLive[i] >= 0 || inDraft[i] >= 0) continue;
    out.splice(i === 0 ? 0 : out.indexOf(i - 1) + 1, 0, i);
  }
  return out;
}

/**
 * Lay a side's blocks out in `order`. A piece stays with its unit; any other new block stays behind
 * the block before it.
 */
function layOut(side: Side, c: Correspondence, order: number[]): number[] {
  const owner = new Int32Array(side.blocks.length).fill(-1);
  for (const i of order) if (c.partner[i] >= 0) owner[c.partner[i]] = i;

  const attachedAfter = new Map<number, number[]>(); // base block -> side blocks placed after it
  const leading: number[] = [];
  let prev = -1;
  for (let j = 0; j < side.blocks.length; j++) {
    if (owner[j] >= 0) {
      prev = owner[j];
      continue;
    }
    const host = c.nextPiece[j] >= 0 ? c.back[c.nextPiece[j]] : prev;
    if (host < 0) leading.push(j);
    else attachedAfter.set(host, [...(attachedAfter.get(host) ?? []), j]);
  }
  const out: number[] = [...leading];
  for (const i of order) {
    if (c.partner[i] >= 0) out.push(c.partner[i]);
    for (const x of attachedAfter.get(i) ?? []) out.push(x);
  }
  return out;
}

/**
 * Block order, merged on its own: decide each pair of base blocks' order, then lay base, live and
 * draft out in that one order. The token merge then sees no moves, only edits.
 */
export function mergeOrder(sides: {
  base: Side;
  live: Side;
  draft: Side;
  inLive: Correspondence;
  inDraft: Correspondence;
}): OrderMerge {
  const { base, live, draft } = sides;
  const [inLive, inDraft] = [sides.inLive.partner, sides.inDraft.partner];
  const kept = base.blocks.map((_, i) => i).filter((i) => inLive[i] >= 0 || inDraft[i] >= 0);

  const keepsBaseOrder = (partner: Int32Array) => {
    let last = -1;
    for (const i of kept) {
      if (partner[i] < 0) continue;
      if (partner[i] < last) return false;
      last = partner[i];
    }
    return true;
  };
  if (keepsBaseOrder(inLive) && keepsBaseOrder(inDraft))
    return { reordered: false, cyclic: false, contested: [], inLive, inDraft };

  const placement = placeBlocks(kept, inLive, inDraft);
  const baseOrder = withRemovedBlocks(placement.order, base.blocks.length, inLive, inDraft);
  const liveOrder = layOut(live, sides.inLive, baseOrder);
  const draftOrder = layOut(draft, sides.inDraft, baseOrder);
  return {
    inLive,
    inDraft,
    liveOrder,
    draftOrder,
    reordered: true,
    cyclic: placement.cyclic,
    contested: placement.contested,
    baseOrder,
    live: liveOrder.map((i) => live.blocks[i]),
    draft: draftOrder.map((i) => draft.blocks[i]),
  };
}
