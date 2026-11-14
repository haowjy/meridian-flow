/**
 * Block correspondence: for two versions of a sequence of blocks (top-level blocks, a list's items,
 * the atoms of a paragraph), which old block each new block is. The model's write path and the Yjs
 * writer both ask here, so they agree on one answer.
 *
 * This is guess mode: an unmade pairing costs the writer a deleted and an inserted block, and a
 * wrong one costs a block edited into another. Pairs are always in order, and only blocks of one
 * type pair, because one element cannot change its type.
 */
import { DIFF_EQUAL } from "@sanity/diff-match-patch";
import type { Node as PMNode } from "prosemirror-model";
import { weightedOrderedMatches } from "../ordered-matching.js";
import { blockKey, contentWords, diffKeys, sharedBound, similarity } from "./tokens.js";

export interface Correspondence {
  /** Old index to the new index of the first block of its unit, or -1. */
  partner: Int32Array;
  /** New index to the old index of the first block of its unit, or -1. */
  back: Int32Array;
  /** Old index to the first old block of the unit it was joined into, or -1. */
  oldPiece: Int32Array;
  /** New index to the first new block of the unit it was split from, or -1. */
  nextPiece: Int32Array;
}

const TUNE = {
  /** Share of words two blocks must have in common to be the same block edited. */
  similar: 0.5,
  /** Share of a block's words that must be in a pair for the block to be a split or a join's piece. */
  piece: 0.5,
  /** Old-by-new pairs searched exhaustively; a larger gap is searched in a band. */
  cells: 10_000,
  /** Table size the band search may allocate. */
  work: 4_000_000,
  /** Band half-width, in blocks, around the diagonal of a large gap. */
  band: 40,
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

/** Weight of a pair that shares enough words to be one block edited; weaker pairs weigh less. */
const SIMILAR = 5_000;

/**
 * Score of pairing two blocks of one type: same content beats similar text beats a weaker overlap
 * beats nothing in common (1: an unrelated rewrite keeps its elements, and a peer's typing in them,
 * by position). Blocks of different types never pair (0).
 */
const weight = (a: PMNode, b: PMNode) => remembered(scoresOf(0, a), b, () => scoreWeight(a, b));

function scoreWeight(a: PMNode, b: PMNode): number {
  if (a.type !== b.type) return 0;
  if (sameContent(a, b)) return 20_000 + Math.round(100 * attrShare(a, b));
  const sim = similarity(a, b, false, TUNE.similar);
  if (sim >= TUNE.similar) {
    const x = contentWords(a);
    const y = contentWords(b);
    let lead = 0;
    while (lead < 63 && lead < x.length && lead < y.length && x[lead] === y[lead]) lead++;
    return Math.round(sim * 100) * 100 + lead;
  }
  const longer = Math.max(contentWords(a).length, contentWords(b).length);
  return 1 + (longer ? Math.round((100 * sharedBound(a, b)) / longer) : 0);
}

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

export function correspond(old: readonly PMNode[], next: readonly PMNode[]): Correspondence {
  const c: Correspondence = {
    partner: new Int32Array(old.length).fill(-1),
    back: new Int32Array(next.length).fill(-1),
    oldPiece: new Int32Array(old.length).fill(-1),
    nextPiece: new Int32Array(next.length).fill(-1),
  };
  for (const [i, j] of pairRun(old, next)) {
    c.partner[i] = j;
    c.back[j] = i;
  }
  findPieces(old, next, c);
  rootUnits(old, next, c);
  return c;
}

/** The ends, the anchors, then everything left in each gap at once. */
function pairRun(old: readonly PMNode[], next: readonly PMNode[]) {
  const pairs: Array<[number, number]> = [];
  let [o0, o1, n0, n1] = [0, old.length, 0, next.length];
  while (o0 < o1 && n0 < n1 && blockKey(old[o0]) === blockKey(next[n0])) pairs.push([o0++, n0++]);
  while (o0 < o1 && n0 < n1 && blockKey(old[o1 - 1]) === blockKey(next[n1 - 1]))
    pairs.push([--o1, --n1]);
  const anchors = findAnchors(old, next, o0, o1, n0, n1);
  const pairGap = (a0: number, a1: number, b0: number, b1: number) => {
    const rows = a1 - a0;
    const cols = b1 - b0;
    if (!rows || !cols) return;
    // Within a large gap only pairs near its diagonal are scored; the bar for a pair stays the same.
    const ratio = cols / rows;
    const banded = rows * cols > TUNE.cells;
    const matches =
      weightedOrderedMatches(
        (i, j) =>
          banded && Math.abs(j - b0 - (i - a0) * ratio) > TUNE.band ? 0 : weight(old[i], next[j]),
        a0,
        a1,
        b0,
        b1,
        TUNE.work,
      ) ?? [];
    for (const [i, j] of matches) pairs.push([i, j]);
  };
  let [ao, an] = [o0, n0];
  for (const [i, j] of [...anchors, [o1, n1] as [number, number]]) {
    pairGap(ao, i, an, j);
    if (i < o1) pairs.push([i, j]);
    [ao, an] = [i + 1, j + 1];
  }
  return pairs;
}

/**
 * A block whose content occurs once on each side is the same block: an anchor, as in a patience
 * diff. Candidates that cross (either could be the one that stayed) are not anchors; the gap's
 * best in-order pairing keeps one of them.
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
  for (const level of atLevel.values()) if (level.length === 1) anchors.push(level[0]);
  return anchors.sort((a, b) => a[0] - b[0]);
}

const sameType = (a: PMNode, b: PMNode) => a.type === b.type;

const squash = (n: PMNode) => n.textContent.replace(/\s+/gu, "");

/**
 * An unpaired block beside a pair is a piece when at least half its words are in the pair's other
 * side and the pair reads better with it: the rest of a split or a join. Words segment differently
 * on the two sides when a split lands inside a word of a script without spaces, so the piece also
 * counts when pair and piece together are exact text of the other side.
 */
function findPieces(old: readonly PMNode[], next: readonly PMNode[], c: Correspondence) {
  const { partner, back } = c;
  for (let i = 0; i < old.length; i++) {
    const j = partner[i];
    if (j < 0 || !sameType(old[i], next[j])) continue;
    // Most pairs have no unpaired neighbour; counting words for them dominates a large document.
    const open = (k: number, side: readonly PMNode[], other: Int32Array) =>
      k >= 0 && k < side.length && other[k] < 0;
    if (
      !(open(i - 1, old, partner) || open(i + 1, old, partner)) &&
      !(open(j - 1, next, back) || open(j + 1, next, back))
    )
      continue;
    let ow = contentWords(old[i]);
    let nw = contentWords(next[j]);
    let [ot, nt] = [squash(old[i]), squash(next[j])];
    for (const dir of [-1, 1]) {
      for (
        let k = i + dir;
        k >= 0 && k < old.length && partner[k] < 0 && c.oldPiece[k] < 0 && sameType(old[i], old[k]);
        k += dir
      ) {
        const w = contentWords(old[k]);
        const t = squash(old[k]);
        const joined = dir < 0 ? [...w, ...ow] : [...ow, ...w];
        const joinedText = dir < 0 ? t + ot : ot + t;
        const reads =
          (w.length > 0 &&
            contained(w, nw) >= TUNE.piece &&
            wordSim(joined, nw) > wordSim(ow, nw)) ||
          (t.length > 0 && nt.includes(joinedText));
        if (!reads) break;
        c.oldPiece[k] = i;
        [ow, ot] = [joined, joinedText];
      }
      for (
        let k = j + dir;
        k >= 0 &&
        k < next.length &&
        back[k] < 0 &&
        c.nextPiece[k] < 0 &&
        sameType(next[j], next[k]);
        k += dir
      ) {
        const w = contentWords(next[k]);
        const t = squash(next[k]);
        const joined = dir < 0 ? [...w, ...nw] : [...nw, ...w];
        const joinedText = dir < 0 ? t + nt : nt + t;
        const reads =
          (w.length > 0 &&
            contained(w, ow) >= TUNE.piece &&
            wordSim(ow, joined) > wordSim(ow, nw)) ||
          (t.length > 0 && ot.includes(joinedText));
        if (!reads) break;
        c.nextPiece[k] = j;
        [nw, nt] = [joined, joinedText];
      }
    }
  }
}

/**
 * A unit's pair is its first old block and its first new block; every other block of the unit is a
 * piece of that one. Yjs keeps the first block's identity through a split and a join.
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
