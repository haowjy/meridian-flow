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
import { blockKey, blockWords, diffKeys, similarity } from "./tokens.js";

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
}

const TUNE = {
  /** Share of words two blocks must have in common to be the same block edited. */
  similar: 0.5,
  /** A pairing is kept only if giving it up costs at least this share of its score. */
  margin: 0.2,
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

/** Score of pairing two blocks: same content beats similar text beats nothing (0). */
function weight(a: PMNode, b: PMNode, floor = TUNE.similar): number {
  if (sameContent(a, b)) return 20_000 + Math.round(100 * attrShare(a, b));
  const sim = similarity(a, b, false, floor);
  if (sim < floor) return 0;
  const x = words(a);
  const y = words(b);
  let lead = 0;
  while (lead < 63 && lead < x.length && lead < y.length && x[lead] === y[lead]) lead++;
  return Math.round(sim * 100) * 100 + lead;
}

const words = (n: PMNode) => (n.isTextblock ? blockWords(n) : []);

const commonWords = (x: readonly string[], y: readonly string[]) => {
  let n = 0;
  if (x.length && y.length) for (const [op, k] of diffKeys(x, y)) if (op === DIFF_EQUAL) n += k;
  return n;
};
const wordSim = (x: readonly string[], y: readonly string[]) =>
  x.length && y.length ? commonWords(x, y) / Math.max(x.length, y.length) : 0;
const contained = (piece: readonly string[], whole: readonly string[]) =>
  piece.length ? commonWords(piece, whole) / piece.length : 0;

export function correspond(
  old: readonly PMNode[],
  next: readonly PMNode[],
  opts: { moves?: boolean; guess?: boolean } = {},
): Correspondence {
  const c: Correspondence = {
    partner: new Int32Array(old.length).fill(-1),
    back: new Int32Array(next.length).fill(-1),
    moved: new Set(),
    oldPiece: new Int32Array(old.length).fill(-1),
    nextPiece: new Int32Array(next.length).fill(-1),
  };
  const pair = (i: number, j: number) => {
    c.partner[i] = j;
    c.back[j] = i;
  };
  for (const [i, j] of pairRun(old, next, !!opts.guess)) pair(i, j);
  findPieces(old, next, c);
  rootUnits(old, next, c);
  if (opts.moves) findMoves(old, next, c);
  return c;
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
    for (let r = 0; r < rows; r++)
      for (let q = 0; q < cols; q++)
        w[r * cols + q] = skipped(a0 + r, b0 + q) ? 0 : weight(old[a0 + r], next[b0 + q]);
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
  // Length of the longest in-order set ending at, and starting at, each candidate.
  const left = cand.map(() => 1);
  const right = cand.map(() => 1);
  for (let k = 0; k < cand.length; k++)
    for (let q = 0; q < k; q++)
      if (cand[q][1] < cand[k][1]) left[k] = Math.max(left[k], left[q] + 1);
  for (let k = cand.length - 1; k >= 0; k--)
    for (let q = k + 1; q < cand.length; q++)
      if (cand[k][1] < cand[q][1]) right[k] = Math.max(right[k], right[q] + 1);
  const longest = Math.max(0, ...left);
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
 * Step 3: an unpaired text block beside a pair is a piece when at least half its words are in the
 * pair's other side and the pair reads better with it. A join may take a block from a pair that is
 * out of order, never from one that keeps its order.
 */
function findPieces(old: readonly PMNode[], next: readonly PMNode[], c: Correspondence) {
  const { partner, back } = c;
  for (let i = 0; i < old.length; i++) {
    const j = partner[i];
    if (j < 0 || !old[i].isTextblock || !next[j].isTextblock) continue;
    let ow = words(old[i]);
    let nw = words(next[j]);
    for (const dir of [-1, 1]) {
      for (let k = i + dir; k >= 0 && k < old.length && c.oldPiece[k] < 0; k += dir) {
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
        k >= 0 && k < next.length && back[k] < 0 && c.nextPiece[k] < 0;
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
  const sims = oldLeft.map((i) =>
    nextLeft.map((j) => similarity(old[i], next[j], false, TUNE.similar)),
  );
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
