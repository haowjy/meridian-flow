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
import { blockKey, contentWords, diffKeys, similarity } from "./tokens.js";

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

/** Score of pairing two blocks of one type: same content beats similar text beats nothing (0). */
const weight = (a: PMNode, b: PMNode, floor = TUNE.similar) =>
  remembered(scoresOf(floor, a), b, () => scoreWeight(a, b, floor));

function scoreWeight(a: PMNode, b: PMNode, floor: number): number {
  if (a.type !== b.type) return 0;
  if (sameContent(a, b)) return 20_000 + Math.round(100 * attrShare(a, b));
  const sim = similarity(a, b, false, floor);
  if (sim < floor) return 0;
  const x = contentWords(a);
  const y = contentWords(b);
  let lead = 0;
  while (lead < 63 && lead < x.length && lead < y.length && x[lead] === y[lead]) lead++;
  return Math.round(sim * 100) * 100 + lead;
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
  const { anchors, deferredOld, deferredNext } = findAnchors(old, next, o0, o1, n0, n1);
  const pairGap = (a0: number, a1: number, b0: number, b1: number) => {
    const rows = a1 - a0;
    const cols = b1 - b0;
    if (!rows || !cols) return;
    const skipped = (i: number, j: number) => deferredOld.has(i) || deferredNext.has(j);
    if (rows === 1 && cols === 1) {
      // One block left against one has no rival: it is that block rewritten, whatever words survive.
      if (!skipped(a0, b0) && old[a0].type === next[b0].type) pairs.push([a0, b0]);
      return;
    }
    if (rows * cols > TUNE.cells) {
      pairs.push(...pairLargeGap(old, next, a0, a1, b0, b1, skipped));
      return;
    }
    // Blocks of one type that share no words still weigh 1, so an unrelated rewrite keeps its
    // elements (and a peer's typing in them) by position between the pairs that do share words.
    const w = new Uint32Array(rows * cols);
    for (let r = 0; r < rows; r++)
      for (let q = 0; q < cols; q++)
        if (!skipped(a0 + r, b0 + q))
          w[r * cols + q] =
            weight(old[a0 + r], next[b0 + q]) || (old[a0 + r].type === next[b0 + q].type ? 1 : 0);
    const matches =
      weightedOrderedMatches((i, j) => w[(i - a0) * cols + (j - b0)], a0, a1, b0, b1, TUNE.work) ??
      [];
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
 * best in-order pairing decides them.
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
 * pair, and the rest stay unpaired.
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

/** Whether two blocks may be halves of one: text blocks of any type, or containers of one type. */
const piecesOf = (a: PMNode, b: PMNode) =>
  a.isTextblock ? b.isTextblock : !b.isTextblock && a.type === b.type;

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
    if (j < 0 || !piecesOf(old[i], next[j])) continue;
    let ow = contentWords(old[i]);
    let nw = contentWords(next[j]);
    let [ot, nt] = [squash(old[i]), squash(next[j])];
    for (const dir of [-1, 1]) {
      for (
        let k = i + dir;
        k >= 0 && k < old.length && partner[k] < 0 && c.oldPiece[k] < 0 && piecesOf(old[i], old[k]);
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
        piecesOf(next[j], next[k]);
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
