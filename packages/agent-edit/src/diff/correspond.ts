/**
 * Block correspondence: for two versions of a sequence of blocks (top-level blocks, a list's items, a
 * table's rows), which old block each new block is. Every place that pairs blocks asks here, so the
 * merge, review and the writers agree on one answer.
 *
 * Two modes. The merge asks in certain mode: a pairing that another reading of the run explains
 * nearly as well is not made. Review asks in guess mode, where an unmade pairing costs a coarser
 * picture and a wrong one costs nothing the merge acts on.
 */
import { DIFF_EQUAL } from "@sanity/diff-match-patch";
import type { Node as PMNode } from "prosemirror-model";
import { weightedOrderedMatches } from "../ordered-matching.js";
import { Dsu } from "./dsu.js";
import { blockKey, blockWords, contentWords, diffKeys, similarity } from "./tokens.js";

export interface Correspondence {
  /** Old index to the new index of the first block of its unit, or -1. */
  partner: Int32Array;
  /** New index to the old index of the first block of its unit, or -1. */
  back: Int32Array;
  /** Old blocks paired out of order. */
  moved: Set<number>;
  /** Old index to the first old block of the unit it was joined into, or -1. */
  oldPiece: Int32Array;
  /** New index to the first new block of the unit it was split from, or -1. */
  nextPiece: Int32Array;
  /** Old index to its unsure group, or -1 (certain mode). */
  unsureOld: Int32Array;
  /** New index to its unsure group, or -1. */
  unsureNext: Int32Array;
}

export const emptyCorrespondence = (oldCount: number, nextCount: number): Correspondence => ({
  partner: new Int32Array(oldCount).fill(-1),
  back: new Int32Array(nextCount).fill(-1),
  moved: new Set(),
  oldPiece: new Int32Array(oldCount).fill(-1),
  nextPiece: new Int32Array(nextCount).fill(-1),
  unsureOld: new Int32Array(oldCount).fill(-1),
  unsureNext: new Int32Array(nextCount).fill(-1),
});

const TUNE = {
  /** Share of words two blocks must have in common to be the same block edited. */
  similar: 0.5,
  /** A pairing is kept only if giving it up costs at least this share of its score. */
  margin: 0.2,
  /** Words two added blocks must share, in order, to be one block (all of the smaller block's, if fewer). */
  sharedFloor: 3,
  /** Share of a block's words that must be in a pair for the block to be a split or a join's piece. */
  piece: 0.5,
  /** Old-by-new pairs searched exhaustively; a larger gap is searched in a band. */
  cells: 40_000,
  /** Table size the band search may allocate. */
  work: 4_000_000,
  /** Band half-width, in blocks, around the diagonal of a large gap. */
  band: 40,
  /** Words in common, over the longer block, to pair inside a large gap. */
  bandSimilar: 0.8,
};

const sameContent = (a: PMNode, b: PMNode) => a.type === b.type && a.content.eq(b.content);

const contentKeys = new WeakMap<PMNode, string>();
function contentKey(n: PMNode): string {
  let k = contentKeys.get(n);
  if (k === undefined) {
    k = `${n.type.name}\u0001${JSON.stringify(n.content.toJSON())}`;
    contentKeys.set(n, k);
  }
  return k;
}

/** Share of equal attributes and marks: breaks ties between blocks with the same content. */
function attrShare(a: PMNode, b: PMNode): number {
  const keys = Object.keys(a.attrs);
  let equal =
    a.marks.length === b.marks.length && a.marks.every((m, i) => m.eq(b.marks[i])) ? 1 : 0;
  for (const k of keys) if (JSON.stringify(a.attrs[k]) === JSON.stringify(b.attrs[k])) equal++;
  return equal / (keys.length + 1);
}

/**
 * Scores of an old node against new nodes, remembered per `kind` of score: a projection after one
 * keystroke scores only the pairs that touch the new node, because every other block of both sides
 * is the node the last projection saw.
 */
const scores = new Map<number, WeakMap<object, WeakMap<object, number>>>();
function scoresOf(kind: number, a: object): WeakMap<object, number> {
  const byOld = scores.get(kind) ?? new WeakMap<object, WeakMap<object, number>>();
  scores.set(kind, byOld);
  const byNew = byOld.get(a) ?? new WeakMap<object, number>();
  byOld.set(a, byNew);
  return byNew;
}
function remembered(memo: WeakMap<object, number>, b: object, score: () => number): number {
  const known = memo.get(b);
  if (known !== undefined) return known;
  const v = score();
  memo.set(b, v);
  return v;
}

/** Score of pairing two blocks: same content beats similar text beats nothing (0). */
const weight = (a: PMNode, b: PMNode, floor = TUNE.similar) =>
  remembered(scoresOf(floor, a), b, () => scoreWeight(a, b, floor));

function scoreWeight(a: PMNode, b: PMNode, floor: number): number {
  if (sameContent(a, b)) return 20_000 + Math.round(100 * attrShare(a, b));
  const sim = similarity(a, b, false, floor);
  if (sim < floor) return 0;
  const x = words(a);
  const y = words(b);
  let lead = 0;
  while (lead < 63 && lead < x.length && lead < y.length && x[lead] === y[lead]) lead++;
  return Math.round(sim * 100) * 100 + lead;
}

const words = contentWords;

/** Words in common, in order. A block's own word list is the same array each projection, so it is remembered. */
const commonWords = (x: readonly string[], y: readonly string[]) =>
  remembered(scoresOf(-2, x), y, () => {
    let n = 0;
    if (x.length && y.length) for (const [op, k] of diffKeys(x, y)) if (op === DIFF_EQUAL) n += k;
    return n;
  });
const wordSim = (x: readonly string[], y: readonly string[]) =>
  x.length && y.length ? commonWords(x, y) / Math.max(x.length, y.length) : 0;
const contained = (piece: readonly string[], whole: readonly string[]) =>
  piece.length ? commonWords(piece, whole) / piece.length : 0;

export function correspond(
  old: readonly PMNode[],
  next: readonly PMNode[],
  opts: { moves?: boolean; guess?: boolean } = {},
): Correspondence {
  const c = emptyCorrespondence(old.length, next.length);
  const pair = (i: number, j: number) => {
    c.partner[i] = j;
    c.back[j] = i;
  };
  for (const [i, j] of pairRun(old, next, !!opts.guess)) pair(i, j);
  findPieces(old, next, c);
  rootUnits(old, next, c);
  if (opts.moves) findMoves(old, next, c);
  if (!opts.guess) markUnsure(old, next, c);
  return c;
}

/** Words two blocks share in order and the size of the smaller one; null when under half the smaller's. */
function overlap(a: PMNode, b: PMNode) {
  const sim = similarity(a, b, true, TUNE.similar);
  if (sim < TUNE.similar) return null;
  const [x, y] = [contentWords(a).length, contentWords(b).length];
  const smaller = Math.min(x, y);
  return { shared: Math.round(sim * smaller), smaller, larger: Math.max(x, y) };
}

/**
 * Two blocks added at one place have no base block to vouch for either: at least half the smaller
 * block's words in the other, in order, and three of them (or all of a smaller block's). Without
 * the floor two short unrelated paragraphs ("Live lore." and "Pending lore.") share one word and
 * read as one block.
 */
export function couldBeSameAddition(a: PMNode, b: PMNode): boolean {
  const o = overlap(a, b);
  return !!o && o.shared >= Math.min(TUNE.sharedFloor, o.smaller);
}

/**
 * Two blocks in different places: nothing but their words says they are one. Three shared words
 * are needed, however short the blocks, or all of them: a short line ("No.") shares its words with
 * a paragraph anywhere, and linking those would pull both places into one change, but the same
 * short line twice ("Yes." and "Yes.") is one block that moved. A smaller block that has an equal
 * twin on its own side ("Yes." twice, one of them edited) is ambiguous about which was edited, which
 * is what an unsure group is for, so its words are evidence too.
 */
function couldBeOneAcross(a: PMNode, b: PMNode, smallerHasTwin: boolean): boolean {
  const o = overlap(a, b);
  return (
    !!o &&
    (o.shared >= TUNE.sharedFloor ||
      o.shared === o.larger ||
      (smallerHasTwin && o.shared === o.smaller))
  );
}

/** Steps 1 and 2: the ends, the anchors, then everything left in each gap at once. */
function pairRun(old: readonly PMNode[], next: readonly PMNode[], guess: boolean) {
  const pairs: Array<[number, number]> = [];
  let [o0, o1, n0, n1] = [0, old.length, 0, next.length];
  while (o0 < o1 && n0 < n1 && blockKey(old[o0]) === blockKey(next[n0])) pairs.push([o0++, n0++]);
  while (o0 < o1 && n0 < n1 && blockKey(old[o1 - 1]) === blockKey(next[n1 - 1]))
    pairs.push([--o1, --n1]);
  const { anchors, deferredOld, deferredNext } = findAnchors(old, next, o0, o1, n0, n1);
  const pairGap = (a0: number, a1: number, b0: number, b1: number) => {
    const rows = a1 - a0;
    const cols = b1 - b0;
    if (!rows || !cols) return;
    const skipped = (i: number, j: number) => deferredOld.has(i) || deferredNext.has(j);
    if (rows === 1 && cols === 1) {
      // One block left against one: neither has a rival, but unrelated text blocks are not each other.
      const [a, b] = [old[a0], next[b0]];
      if (skipped(a0, b0)) return;
      if (guess || (!a.isTextblock && !b.isTextblock && a.type === b.type) || weight(a, b) > 0)
        pairs.push([a0, b0]);
      return;
    }
    if (rows * cols > TUNE.cells) {
      pairs.push(...pairLargeGap(old, next, a0, a1, b0, b1, skipped));
      return;
    }
    const w = new Uint32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const memo = scoresOf(TUNE.similar, old[a0 + r]);
      for (let q = 0; q < cols; q++)
        if (!skipped(a0 + r, b0 + q))
          w[r * cols + q] = remembered(memo, next[b0 + q], () =>
            scoreWeight(old[a0 + r], next[b0 + q], TUNE.similar),
          );
    }
    const at = (i: number, j: number) => (i - a0) * cols + (j - b0);
    const solve = (without: number) => {
      const m =
        weightedOrderedMatches(
          (i, j) => (at(i, j) === without ? 0 : w[at(i, j)]),
          a0,
          a1,
          b0,
          b1,
          TUNE.work,
        ) ?? [];
      return { m, total: m.reduce((s, [i, j]) => s + w[at(i, j)], 0) };
    };
    const best = solve(-1);
    for (const [i, j] of best.m) {
      if (sameContent(old[i], next[j]) || guess) {
        pairs.push([i, j]);
        continue;
      }
      // Kept only when no other pairing of the run does nearly as well without it, or when the
      // rival is the other half of the same split or join: one unit either way.
      const alt = solve(at(i, j));
      if (best.total - alt.total >= TUNE.margin * w[at(i, j)]) pairs.push([i, j]);
      else {
        const altNext = alt.m.find(([a]) => a === i)?.[1];
        const altOld = alt.m.find(([, b]) => b === j)?.[0];
        if (
          (altNext !== undefined &&
            Math.abs(altNext - j) === 1 &&
            isParts(old[i], next[Math.min(j, altNext)], next[Math.max(j, altNext)])) ||
          (altOld !== undefined &&
            Math.abs(altOld - i) === 1 &&
            isParts(next[j], old[Math.min(i, altOld)], old[Math.max(i, altOld)]))
        )
          pairs.push([i, j]);
      }
    }
  };
  let [ao, an] = [o0, n0];
  for (const [i, j] of [...anchors, [o1, n1] as [number, number]]) {
    pairGap(ao, i, an, j);
    if (i < o1) pairs.push([i, j]);
    [ao, an] = [i + 1, j + 1];
  }
  return pairs;
}

/** Whether two blocks together read as the one block they are halves of. */
function isParts(whole: PMNode, a: PMNode, b: PMNode): boolean {
  const [x, y] = [words(whole), [...words(a), ...words(b)]];
  return (
    y.length > 0 &&
    commonWords(y, x) / y.length >= TUNE.piece &&
    wordSim(x, y) > Math.max(wordSim(x, words(a)), wordSim(x, words(b)))
  );
}

/**
 * A block whose content occurs once on each side is the same block: an anchor, as in a patience
 * diff. Candidates that cross (either could be the one that stayed) are not anchors; they are left
 * for the moves step.
 */
function findAnchors(
  old: readonly PMNode[],
  next: readonly PMNode[],
  o0: number,
  o1: number,
  n0: number,
  n1: number,
) {
  const index = (nodes: readonly PMNode[], from: number, to: number) => {
    const m = new Map<string, number[]>();
    for (let k = from; k < to; k++) {
      const key = contentKey(nodes[k]);
      const at = m.get(key);
      if (at) at.push(k);
      else m.set(key, [k]);
    }
    return m;
  };
  const inNext = index(next, n0, n1);
  const cand: Array<[number, number]> = [];
  for (const [key, at] of index(old, o0, o1)) {
    const other = inNext.get(key);
    if (at.length === 1 && other?.length === 1) cand.push([at[0], other[0]]);
  }
  cand.sort((x, y) => x[0] - y[0]);
  // Length of the longest in-order set ending at, and starting at, each candidate (patience sorting).
  const lengthsEndingAt = (values: number[]) => {
    const tails: number[] = [];
    return values.map((v) => {
      let [lo, hi] = [0, tails.length];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      tails[lo] = v;
      return lo + 1;
    });
  };
  const left = lengthsEndingAt(cand.map(([, j]) => j));
  const right = lengthsEndingAt(cand.map(([, j]) => -j).reverse()).reverse();
  const longest = left.reduce((m, v) => Math.max(m, v), 0);
  // One candidate at its place in every longest set is an anchor; two at one place cross.
  const atLevel = new Map<number, Array<[number, number]>>();
  cand.forEach((pair, k) => {
    if (left[k] + right[k] - 1 !== longest) return;
    atLevel.set(left[k], [...(atLevel.get(left[k]) ?? []), pair]);
  });
  const anchors: Array<[number, number]> = [];
  const deferredOld = new Set<number>();
  const deferredNext = new Set<number>();
  for (const level of atLevel.values())
    for (const pair of level) {
      if (level.length === 1) anchors.push(pair);
      else {
        deferredOld.add(pair[0]);
        deferredNext.add(pair[1]);
      }
    }
  anchors.sort((a, b) => a[0] - b[0]);
  return { anchors, deferredOld, deferredNext };
}

/**
 * A gap too large to score pair by pair. A run of the same length whose blocks all pair in place
 * pairs in place; otherwise only blocks that are nearly the same text and near the gap's diagonal
 * pair, and the rest stay unpaired (`coarse-diff`).
 */
function pairLargeGap(
  old: readonly PMNode[],
  next: readonly PMNode[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  skipped: (i: number, j: number) => boolean,
): Array<[number, number]> {
  const rows = a1 - a0;
  const cols = b1 - b0;
  if (rows === cols) {
    const inPlace = Array.from({ length: rows }, (_, k) => [a0 + k, b0 + k] as [number, number]);
    if (inPlace.every(([i, j]) => !skipped(i, j) && weight(old[i], next[j], TUNE.bandSimilar) > 0))
      return inPlace;
  }
  const ratio = cols / rows;
  return (
    weightedOrderedMatches(
      (i, j) =>
        skipped(i, j) || Math.abs(j - b0 - (i - a0) * ratio) > TUNE.band
          ? 0
          : weight(old[i], next[j], TUNE.bandSimilar),
      a0,
      a1,
      b0,
      b1,
      TUNE.work,
    ) ?? []
  ).map(([i, j]) => [i, j]);
}

/**
 * Step 3: an unpaired block beside a pair is a piece when at least half its words are in the pair's
 * other side and the pair reads better with it. Text blocks are pieces of each other whatever their
 * type; a container's children (a list's items, a table's rows) are pieces of children of the same
 * type, so a join of items is owned in one place and a move can't pair half of it elsewhere. A join
 * may take a block from a pair that is out of order, never from one that keeps its order.
 */
/** Whether two blocks may be halves of one: text blocks of any type, or containers of one type. */
const piecesOf = (a: PMNode, b: PMNode) =>
  a.isTextblock ? b.isTextblock : !b.isTextblock && a.type === b.type;

function findPieces(old: readonly PMNode[], next: readonly PMNode[], c: Correspondence) {
  const { partner, back } = c;
  for (let i = 0; i < old.length; i++) {
    const j = partner[i];
    if (j < 0 || !piecesOf(old[i], next[j])) continue;
    let ow = words(old[i]);
    let nw = words(next[j]);
    for (const dir of [-1, 1]) {
      for (let k = i + dir; k >= 0 && k < old.length && c.oldPiece[k] < 0; k += dir) {
        if (!piecesOf(old[i], old[k])) break;
        // A block paired with one that is not beside this pair, by equal content alone, may be this
        // join's piece instead: the join is the nearer explanation.
        const far =
          partner[k] >= 0 &&
          (k - i) * (partner[k] - j) < 0 &&
          sameContent(old[k], next[partner[k]]);
        if (partner[k] >= 0 && !far) break;
        const w = words(old[k]);
        const joined = dir < 0 ? [...w, ...ow] : [...ow, ...w];
        if (!w.length || contained(w, nw) < TUNE.piece || wordSim(joined, nw) <= wordSim(ow, nw))
          break;
        if (far) {
          back[partner[k]] = -1;
          partner[k] = -1;
        }
        c.oldPiece[k] = i;
        ow = joined;
      }
      for (
        let k = j + dir;
        k >= 0 &&
        k < next.length &&
        back[k] < 0 &&
        c.nextPiece[k] < 0 &&
        piecesOf(next[j], next[k]);
        k += dir
      ) {
        const w = words(next[k]);
        const joined = dir < 0 ? [...w, ...nw] : [...nw, ...w];
        if (!w.length || contained(w, ow) < TUNE.piece || wordSim(ow, joined) <= wordSim(ow, nw))
          break;
        c.nextPiece[k] = j;
        nw = joined;
      }
    }
  }
}

/**
 * A unit's pair is its first old block and its first new block; every other block of the unit is a
 * piece of that one. Yjs keeps the first block's identity through a split and a join, and the flat
 * model's attribute merge follows it.
 */
function rootUnits(old: readonly PMNode[], next: readonly PMNode[], c: Correspondence) {
  const { partner, back } = c;
  for (let i = 0; i < old.length; i++) {
    const j = partner[i];
    if (j < 0) continue;
    let [u0, u1, v0, v1] = [i, i + 1, j, j + 1];
    while (u0 > 0 && c.oldPiece[u0 - 1] === i) u0--;
    while (v0 > 0 && c.nextPiece[v0 - 1] === j) v0--;
    if (u0 === i && v0 === j) continue;
    while (u1 < old.length && c.oldPiece[u1] === i) u1++;
    while (v1 < next.length && c.nextPiece[v1] === j) v1++;
    partner[i] = -1;
    back[j] = -1;
    for (let k = u0; k < u1; k++) c.oldPiece[k] = k === u0 ? -1 : u0;
    for (let k = v0; k < v1; k++) c.nextPiece[k] = k === v0 ? -1 : v0;
    partner[u0] = v0;
    back[v0] = u0;
  }
}

/** Step 4: among what is left, an old and a new block that are each other's clear best candidate moved. */
function findMoves(old: readonly PMNode[], next: readonly PMNode[], c: Correspondence) {
  const oldLeft = [...c.partner.keys()].filter((i) => c.partner[i] < 0 && c.oldPiece[i] < 0);
  const nextLeft = [...c.back.keys()].filter((j) => c.back[j] < 0 && c.nextPiece[j] < 0);
  if (!oldLeft.length || !nextLeft.length || oldLeft.length * nextLeft.length > TUNE.cells) return;
  // Kinds: a floor is a weight, -1 a similarity, -2 a word count.
  const sims = oldLeft.map((i) => {
    const memo = scoresOf(-1, old[i]);
    return nextLeft.map((j) =>
      remembered(memo, next[j], () => similarity(old[i], next[j], false, TUNE.similar)),
    );
  });
  const clear = (vals: number[], k: number) =>
    vals[k] >= TUNE.similar && vals.every((v, q) => q === k || v <= vals[k] * (1 - TUNE.margin));
  oldLeft.forEach((i, r) => {
    let a = 0;
    sims[r].forEach((v, q) => {
      if (v > sims[r][a]) a = q;
    });
    if (
      !clear(sims[r], a) ||
      !clear(
        oldLeft.map((_, rr) => sims[rr][a]),
        r,
      )
    )
      return;
    if (c.back[nextLeft[a]] >= 0) return;
    c.partner[i] = nextLeft[a];
    c.back[nextLeft[a]] = i;
    c.moved.add(i);
  });
}

/** The words of `x` that `y` does not account for, counting repeats. */
function wordsNotIn(x: readonly string[], y: readonly string[]): string[] {
  const have = new Map<string, number>();
  for (const w of y) have.set(w, (have.get(w) ?? 0) + 1);
  return x.filter((w) => {
    const n = have.get(w) ?? 0;
    if (n) have.set(w, n - 1);
    return !n;
  });
}

/**
 * Step 5, certain mode: the blocks whose pairing nothing settles, in groups. One group is one
 * question, so the merge can answer it once:
 * - an old and a new block that could be one block, wherever they sit and with the words to show
 *   it: removed here and added there, cut down, or grown;
 * - old and new blocks left in one gap: an edit past recognition, or a removal and an addition;
 * - a removed block and a changed pair that gained half of that block's words (or half of whose
 *   gained words are that block's), and the same for an added block and a pair that lost words:
 *   a join or a split that also rewrote the text.
 */
function markUnsure(old: readonly PMNode[], next: readonly PMNode[], c: Correspondence) {
  const { partner, back } = c;
  const N = old.length;
  const groups = new Dsu(N + next.length);
  const link = (a: number, b: number) => groups.union(a, b);
  const freeOld = (i: number) => partner[i] < 0 && c.oldPiece[i] < 0;
  const freeNext = (j: number) => back[j] < 0 && c.nextPiece[j] < 0;
  const oldLeft = [...partner.keys()].filter(freeOld);
  const nextLeft = [...back.keys()].filter(freeNext);
  // Past the pair limit everything left is one group.
  if (oldLeft.length * nextLeft.length > TUNE.cells) {
    for (const i of oldLeft) link(i, oldLeft[0]);
    for (const j of nextLeft) link(N + j, oldLeft[0]);
  } else {
    const twins = (nodes: readonly PMNode[]) => {
      const seen = new Map<string, number>();
      for (const n of nodes) seen.set(contentKey(n), (seen.get(contentKey(n)) ?? 0) + 1);
      return (n: PMNode) => (seen.get(contentKey(n)) ?? 0) > 1;
    };
    const [oldTwin, nextTwin] = [twins(old), twins(next)];
    for (const i of oldLeft)
      for (const j of nextLeft) {
        const oldIsSmaller = contentWords(old[i]).length <= contentWords(next[j]).length;
        const twin = oldIsSmaller ? oldTwin(old[i]) : nextTwin(next[j]);
        if (couldBeOneAcross(old[i], next[j], twin)) link(i, N + j);
      }
  }
  // Old and new blocks left in one gap between two pairs in order.
  const unitEnd = (pi: number, pj: number): [number, number] => {
    let [u1, v1] = [pi + 1, pj + 1];
    while (u1 < old.length && c.oldPiece[u1] === pi) u1++;
    while (v1 < next.length && c.nextPiece[v1] === pj) v1++;
    return [u1, v1];
  };
  let [i, j] = [0, 0];
  while (i <= old.length) {
    let pi = i;
    while (pi < old.length && !(partner[pi] >= 0 && !c.moved.has(pi))) pi++;
    const pj = pi < old.length ? partner[pi] : next.length;
    const gapOld: number[] = [];
    const gapNext: number[] = [];
    for (let k = i; k < pi; k++) if (freeOld(k)) gapOld.push(k);
    for (let k = j; k < pj; k++) if (freeNext(k)) gapNext.push(k);
    if (gapOld.length && gapNext.length) {
      for (const k of gapOld) link(k, gapOld[0]);
      for (const k of gapNext) link(N + k, gapOld[0]);
    }
    if (pi >= old.length) break;
    [i, j] = unitEnd(pi, pj);
  }
  // A join or a split that also rewrote the text.
  const text = (n: PMNode) => contentWords(n);
  const took = (from: readonly string[], inside: readonly string[]) =>
    from.length > 0 && (from.length - wordsNotIn(from, inside).length) / from.length >= TUNE.piece;
  if (oldLeft.length || nextLeft.length)
    for (let pi = 0; pi < old.length; pi++) {
      const pj = partner[pi];
      if (pj < 0 || sameContent(old[pi], next[pj])) continue;
      const [u1, v1] = unitEnd(pi, pj);
      const ow = old.slice(pi, u1).flatMap(text);
      const nw = next.slice(pj, v1).flatMap(text);
      const gained = wordsNotIn(nw, ow);
      const lost = wordsNotIn(ow, nw);
      if (gained.length)
        for (const k of oldLeft)
          if (took(gained, text(old[k])) || took(text(old[k]), gained)) link(k, pi);
      if (lost.length)
        for (const k of nextLeft)
          if (took(lost, text(next[k])) || took(text(next[k]), lost)) link(N + k, pi);
    }
  const size = new Map<number, number>();
  for (let k = 0; k < N + next.length; k++)
    size.set(groups.find(k), (size.get(groups.find(k)) ?? 0) + 1);
  for (let k = 0; k < N; k++)
    if ((size.get(groups.find(k)) ?? 0) > 1) c.unsureOld[k] = groups.find(k);
  for (let k = 0; k < next.length; k++)
    if ((size.get(groups.find(N + k)) ?? 0) > 1) c.unsureNext[k] = groups.find(N + k);
}
