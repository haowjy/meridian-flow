/**
 * Block pairing and paragraph order for the content rebase. Pairs base blocks with the blocks of live
 * and of the draft (equal, edited in place, or moved), decides one paragraph order for the three
 * documents, and lays each out in it, so the token merge afterwards sees edits and no moves.
 */
import { DIFF_EQUAL } from "@sanity/diff-match-patch";
import type { Node as PMNode } from "prosemirror-model";
import { weightedOrderedMatches } from "../ordered-matching.js";
import type { Alignment } from "./align.js";
import { blockWords, diffKeys, type Side, similarity } from "./tokens.js";

// A paragraph that moved should take the other side's edits with it. Blocks pair three ways: equal
// blocks the block-level diff kept, similar blocks inside one gap (an edit in place), and similar
// blocks in different gaps (a move, possibly edited too). Similarity is word overlap; it picks which
// paragraph an edit lands in, as diff alignment always does, and never touches Yjs identity.
const PAIR_SIMILARITY = 0.5;
const MAX_PAIR_CELLS = 40_000;
const MAX_MATCH_WORK = 4_000_000;

interface Pairing {
  /** Base block to the side block it stayed as (equal or edited in place), else -1. */
  stayed: Int32Array;
  /** Base blocks that moved, with the side block each moved to, in side order. */
  moves: Array<{ baseBlock: number; sideBlock: number }>;
}

/** Share of `piece`'s words that come from `whole`. */
export function containment(piece: PMNode, whole: PMNode): number {
  const pieceWords = blockWords(piece);
  if (!pieceWords.length || !piece.isTextblock || !whole.isTextblock) return 0;
  let common = 0;
  for (const [op, n] of diffKeys(pieceWords, blockWords(whole))) if (op === DIFF_EQUAL) common += n;
  return common / pieceWords.length;
}

/** Blocks the diff left unmatched, grouped by how many matched blocks precede them (their gap). */
function unmatchedByGap(
  base: Side,
  side: Side,
  stayed: Int32Array,
  sideMatched: Int32Array,
  alignment: Alignment,
): Map<number, { base: number[]; side: number[] }> {
  const gaps = new Map<number, { base: number[]; side: number[] }>();
  const gap = (g: number) => {
    let entry = gaps.get(g);
    if (!entry) {
      entry = { base: [], side: [] };
      gaps.set(g, entry);
    }
    return entry;
  };
  let seen = 0;
  for (let i = 0; i < base.blocks.length; i++) {
    if (alignment.baseToSide[i] >= 0) seen++;
    else if (stayed[i] < 0) gap(seen).base.push(i);
  }
  seen = 0;
  for (let j = 0; j < side.blocks.length; j++) {
    if (alignment.sideToBase[j] >= 0) seen++;
    else if (sideMatched[j] < 0) gap(seen).side.push(j);
  }
  return gaps;
}

/** Bag-of-words similarity, with a bonus for sharing the paragraph's opening words. */
function inGapWeight(baseBlock: PMNode, sideBlock: PMNode): number {
  const sim = similarity(baseBlock, sideBlock, true, PAIR_SIMILARITY);
  if (sim < PAIR_SIMILARITY) return 0;
  const baseWords = blockWords(baseBlock);
  const sideWords = blockWords(sideBlock);
  let lead = 0;
  while (
    lead < 63 &&
    lead < baseWords.length &&
    lead < sideWords.length &&
    baseWords[lead] === sideWords[lead]
  )
    lead++;
  return Math.round(sim * 100) * 64 + lead;
}

/** A moved paragraph may also have been merged with another: count containment of 3+ words too. */
function crossGapSimilarity(baseBlock: PMNode, sideBlock: PMNode): number {
  const sim = similarity(baseBlock, sideBlock, false, PAIR_SIMILARITY);
  if (sim >= PAIR_SIMILARITY) return sim;
  const smaller = Math.min(blockWords(baseBlock).length, blockWords(sideBlock).length);
  const contained = smaller >= 3 ? similarity(baseBlock, sideBlock, true, 0.8) : 0;
  return smaller >= 3 && contained >= 0.8 ? PAIR_SIMILARITY : sim;
}

/** Index of the unique maximum, or -1 when the maximum is tied. */
function uniqueBest(values: number[]): number {
  let best = -1;
  let tie = false;
  values.forEach((v, k) => {
    if (best < 0 || v > values[best]) {
      best = k;
      tie = false;
    } else if (v === values[best]) tie = true;
  });
  return tie ? -1 : best;
}

function pairBlocks(base: Side, side: Side, alignment: Alignment): Pairing {
  const stayed = new Int32Array(base.blocks.length).fill(-1);
  const sideMatched = new Int32Array(side.blocks.length).fill(-1);
  for (let i = 0; i < base.blocks.length; i++) {
    const j = alignment.baseToSide[i];
    if (j >= 0) {
      stayed[i] = j;
      sideMatched[j] = i;
    }
  }

  // In-gap pairs: blocks edited in place.
  const gaps = unmatchedByGap(base, side, stayed, sideMatched, alignment);
  for (const { base: gapBase, side: gapSide } of gaps.values()) {
    if (!gapBase.length || !gapSide.length || gapBase.length * gapSide.length > MAX_PAIR_CELLS)
      continue;
    // Ties (a merged paragraph contains both originals) go to the block it starts with.
    const weight = (x: number, y: number) =>
      inGapWeight(base.blocks[gapBase[x]], side.blocks[gapSide[y]]);
    const matches =
      weightedOrderedMatches(weight, 0, gapBase.length, 0, gapSide.length, MAX_MATCH_WORK) ?? [];
    for (const [x, y] of matches) {
      stayed[gapBase[x]] = gapSide[y];
      sideMatched[gapSide[y]] = gapBase[x];
    }
  }

  // Cross-gap pairs: moves. Mutual best match, unique, and similar enough. Same-gap pairs left over
  // cross each other (a swap inside one gap), so they count as moves too.
  const baseLeft = base.blocks.map((_, i) => i).filter((i) => stayed[i] < 0);
  const sideLeft = side.blocks.map((_, j) => j).filter((j) => sideMatched[j] < 0);
  const moves: Pairing["moves"] = [];
  if (baseLeft.length && sideLeft.length && baseLeft.length * sideLeft.length <= MAX_PAIR_CELLS) {
    const sims = baseLeft.map((i) =>
      sideLeft.map((j) => crossGapSimilarity(base.blocks[i], side.blocks[j])),
    );
    baseLeft.forEach((baseBlock, r) => {
      const a = uniqueBest(sims[r]);
      if (a < 0 || sims[r][a] < PAIR_SIMILARITY) return;
      if (uniqueBest(baseLeft.map((_, rr) => sims[rr][a])) !== r) return;
      moves.push({ baseBlock, sideBlock: sideLeft[a] });
    });
  }
  return { stayed, moves: moves.sort((x, y) => x.sideBlock - y.sideBlock) };
}

/** Base block to its block in the side, whether it stayed or moved; -1 when the side dropped it. */
function partnerOf(pairing: Pairing): Int32Array {
  const partner = Int32Array.from(pairing.stayed);
  for (const move of pairing.moves) partner[move.baseBlock] = move.sideBlock;
  return partner;
}

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
 * Lay a side's blocks out in `order`. New blocks stay attached to the paired block before them, or
 * to the one after if they are a split-off piece of it.
 */
function layOut(base: Side, side: Side, partner: Int32Array, order: number[]): number[] {
  const owner = new Int32Array(side.blocks.length).fill(-1);
  for (const i of order) if (partner[i] >= 0) owner[partner[i]] = i;

  const attachedBefore = new Map<number, number[]>(); // base block -> side blocks placed before it
  const attachedAfter = new Map<number, number[]>();
  const leading: number[] = [];
  let j = 0;
  while (j < side.blocks.length) {
    if (owner[j] >= 0) {
      j++;
      continue;
    }
    let runEnd = j;
    while (runEnd < side.blocks.length && owner[runEnd] < 0) runEnd++;
    const prev = j > 0 ? owner[j - 1] : -1;
    const next = runEnd < side.blocks.length ? owner[runEnd] : -1;
    let split = runEnd;
    while (
      next >= 0 &&
      split > j &&
      containment(side.blocks[split - 1], base.blocks[next]) >= PAIR_SIMILARITY
    )
      split--;
    const behind = Array.from({ length: split - j }, (_, t) => j + t);
    const ahead = Array.from({ length: runEnd - split }, (_, t) => split + t);
    if (prev >= 0) attachedAfter.set(prev, behind);
    else leading.push(...behind);
    if (ahead.length) attachedBefore.set(next, ahead);
    j = runEnd;
  }

  const out: number[] = [...leading];
  for (const i of order) {
    for (const x of attachedBefore.get(i) ?? []) out.push(x);
    if (partner[i] >= 0) out.push(partner[i]);
    for (const x of attachedAfter.get(i) ?? []) out.push(x);
  }
  return out;
}

/**
 * Block order, merged on its own: pair base blocks with live and draft blocks, decide each pair of
 * base blocks' order, then lay base, live and draft out in that one order. The token merge then
 * sees no moves, only edits.
 */
export function mergeOrder(sides: {
  base: Side;
  live: Side;
  draft: Side;
  liveAlignment: Alignment;
  draftAlignment: Alignment;
}): OrderMerge {
  const { base, live, draft } = sides;
  const inLive = partnerOf(pairBlocks(base, live, sides.liveAlignment));
  const inDraft = partnerOf(pairBlocks(base, draft, sides.draftAlignment));
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
  const liveOrder = layOut(base, live, inLive, baseOrder);
  const draftOrder = layOut(base, draft, inDraft, baseOrder);
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
