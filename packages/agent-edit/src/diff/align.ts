/**
 * Align by retained paragraph identity: equal paragraphs anchor the diff; changed paragraphs and
 * small split/join runs are cached units. A new node re-diffs only its unit, while the paragraph pass
 * relocates every cached result. A deterministic size cap guards an oversized unit, never the chapter.
 *
 * Within a unit, words align before punctuation, and paragraph starts follow their first matched word.
 * That keeps a small split or join reading as one edit instead of unrelated paragraph replacements.
 */
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Node as PMNode } from "prosemirror-model";
import { equalOrderedMatches, weightedOrderedMatches } from "../ordered-matching.js";
import { type Hunk, posMap } from "./hunks.js";
import {
  blockKey,
  blockWords,
  buildSide,
  coreKey,
  diffKeys,
  isBlockTok,
  type Side,
  similarity,
  type Tok,
} from "./tokens.js";

export interface Alignment {
  hunks: Hunk[];
  baseToSide: Int32Array; // base block -> equal side block, else -1
  sideToBase: Int32Array;
  pos: Int32Array; // base token -> side token outside hunks, else -1
}

export function align(B: Side, S: Side): Alignment {
  const baseToSide = new Int32Array(B.blocks.length).fill(-1);
  const sideToBase = new Int32Array(S.blocks.length).fill(-1);
  const units: UnitHunk[] = [];
  let bi = 0;
  let si = 0;
  let gb = 0;
  let gs = 0;
  const gap = () => {
    if (gb === bi && gs === si) return;
    for (const [b0, b1, s0, s1] of anchorGap(B, gb, bi, S, gs, si)) {
      if (b0 === b1 && s0 === s1) continue;
      boundedGap(B, b0, b1, S, s0, s1, units);
    }
  };
  for (const [op, n] of diffKeys(B.blocks.map(blockKey), S.blocks.map(blockKey))) {
    if (op === DIFF_EQUAL) {
      gap();
      for (let k = 0; k < n; k++) {
        baseToSide[bi + k] = si + k;
        sideToBase[si + k] = bi + k;
      }
      bi += n;
      si += n;
      gb = bi;
      gs = si;
    } else if (op === DIFF_DELETE) bi += n;
    else if (op === DIFF_INSERT) si += n;
  }
  gap();
  canonicalize(
    B.toks,
    S.toks,
    units.map((unit) => unit.raw),
  );
  const hunks = units.flatMap((unit) => unit.refined);
  return { hunks, baseToSide, sideToBase, pos: posMap(B.toks.length, hunks) };
}

/**
 * A large gap (most paragraphs changed) would make one token diff over thousands of tokens. Split it
 * at paragraphs that are clearly the same paragraph edited in place (80% of words shared, in order,
 * near the same position), so each token diff stays paragraph-sized. Small gaps stay whole: the
 * content-first diff over a gap is what reads a split or a join as one.
 */
// 1,000 tokens preserves ordinary split/join gaps while capping Myers' quadratic search.
// Disjoint 1,000-word paragraphs measured 18–29 ms; 1,500 reached 128 ms (KF30 probe).
// Chapter-sized rewrites pair paragraphs instead, and oversized paragraphs stay whole replacements.
const ANCHOR_GAP_TOKENS = 1000;
const ANCHOR_SIMILAR = 0.8;
const ANCHOR_BAND = 40;

// Repeated recomputes over retained nodes ask the same pairs again; nodes are immutable.
const similarityMemo = new WeakMap<PMNode, WeakMap<PMNode, number>>();
function cachedSimilarity(a: PMNode, b: PMNode): number {
  if (blockWords(a).length > ANCHOR_GAP_TOKENS || blockWords(b).length > ANCHOR_GAP_TOKENS)
    return 0;
  let row = similarityMemo.get(a);
  if (!row) {
    row = new WeakMap();
    similarityMemo.set(a, row);
  }
  let v = row.get(b);
  if (v === undefined) {
    v = similarity(a, b);
    row.set(b, v);
  }
  return v;
}
const wordSets = new WeakMap<PMNode, Set<string>>();
const wordOverlaps = new WeakMap<PMNode, WeakMap<PMNode, number>>();
function cachedWordOverlap(a: PMNode, b: PMNode): number {
  let row = wordOverlaps.get(a);
  if (!row) {
    row = new WeakMap();
    wordOverlaps.set(a, row);
  }
  let overlap = row.get(b);
  if (overlap === undefined) {
    const words = (node: PMNode) => {
      let set = wordSets.get(node);
      if (!set) {
        set = new Set(blockWords(node));
        wordSets.set(node, set);
      }
      return set;
    };
    const sa = words(a);
    const sb = words(b);
    let common = 0;
    for (const word of sa) if (sb.has(word)) common++;
    overlap = sa.size || sb.size ? common / Math.max(sa.size, sb.size) : 1;
    row.set(b, overlap);
  }
  return overlap;
}

function anchorGap(
  B: Side,
  gb: number,
  bi: number,
  S: Side,
  gs: number,
  si: number,
  threshold = ANCHOR_SIMILAR,
): Array<[number, number, number, number]> {
  const whole: Array<[number, number, number, number]> = [[gb, bi, gs, si]];
  if (
    B.starts[bi] - B.starts[gb] <= ANCHOR_GAP_TOKENS &&
    S.starts[si] - S.starts[gs] <= ANCHOR_GAP_TOKENS
  )
    return whole;
  if (bi - gb < 2 || si - gs < 2) return whole;
  // Dense in-place edits need no quadratic paragraph search. This is the same maximal matching
  // the ordered matcher returns when every diagonal pair qualifies.
  if (
    bi - gb === si - gs &&
    B.blocks
      .slice(gb, bi)
      .every(
        (a, k) =>
          a.type === S.blocks[gs + k].type &&
          a.isTextblock &&
          cachedSimilarity(a, S.blocks[gs + k]) >= threshold,
      )
  )
    return Array.from({ length: bi - gb }, (_, k) => [gb + k, gb + k + 1, gs + k, gs + k + 1]);
  const ratio = (si - gs) / (bi - gb);
  const w = (x: number, y: number) => {
    if (Math.abs(y - gs - (x - gb) * ratio) > ANCHOR_BAND) return 0;
    const a = B.blocks[x];
    const b = S.blocks[y];
    if (a.type !== b.type || !a.isTextblock) return 0;
    if (cachedWordOverlap(a, b) < threshold) return 0;
    return cachedSimilarity(a, b) >= threshold ? 1 : 0;
  };
  const m = weightedOrderedMatches(w, gb, bi, gs, si, 4_000_000);
  if (!m?.length) return whole;
  const out: Array<[number, number, number, number]> = [];
  let pb = gb;
  let ps = gs;
  for (const [x, y] of m) {
    out.push([pb, x, ps, y], [x, x + 1, y, y + 1]);
    pb = x + 1;
    ps = y + 1;
  }
  out.push([pb, bi, ps, si]);
  return out;
}

type UnitHunk = { raw: Hunk; refined: Hunk[] };
type UnitMemo = { next: WeakMap<object, UnitMemo>; hunks?: UnitHunk[] };
const units: UnitMemo = { next: new WeakMap() };
const sideBoundary = {};

/**
 * The ordered base nodes, a boundary, then the ordered draft nodes identify one unit. A weak trie
 * retains small multi-paragraph runs without retaining old documents; the boundary distinguishes
 * [a] → [b, c] from [a, b] → [c]. Cached offsets belong to the unit, not its place in the document.
 */
function unitHunks(
  B: Side,
  b0: number,
  b1: number,
  S: Side,
  s0: number,
  s1: number,
  out: UnitHunk[],
) {
  let memo = units;
  const step = (node: object) => {
    let next = memo.next.get(node);
    if (!next) {
      next = { next: new WeakMap() };
      memo.next.set(node, next);
    }
    memo = next;
  };
  for (let b = b0; b < b1; b++) step(B.blocks[b]);
  step(sideBoundary);
  for (let s = s0; s < s1; s++) step(S.blocks[s]);
  if (!memo.hunks) {
    const base = buildSide(B.blocks.slice(b0, b1));
    const draft = buildSide(S.blocks.slice(s0, s1));
    const hunks: Hunk[] = [];
    if (base.toks.length > ANCHOR_GAP_TOKENS || draft.toks.length > ANCHOR_GAP_TOKENS)
      hunks.push({ from: 0, to: base.toks.length, sfrom: 0, ins: draft.toks });
    else tokenHunks(base, 0, base.toks.length, draft, 0, draft.toks.length, hunks);
    memo.hunks = separateBlocks(base, draft, hunks).map((raw) => ({
      raw,
      refined: refine(base.toks, [raw]),
    }));
  }
  const relocate = (h: Hunk): Hunk => ({
    ...h,
    from: h.from + B.starts[b0],
    to: h.to + B.starts[b0],
    sfrom: h.sfrom + S.starts[s0],
  });
  for (const unit of memo.hunks) {
    const raw = relocate(unit.raw);
    // Canonicalization only moves pure insertions/deletions; refinement only splits replacements.
    // Keep the raw neighbour bounds until canonicalization, and share its moved pure hunks.
    out.push({ raw, refined: unit.refined.map((h) => (h === unit.raw ? raw : relocate(h))) });
  }
}

/**
 * An unmatched interval may include a paragraph's changed tail and whole removed/added blocks.
 * Keep complete blocks independent of the partial blocks at either edge, even without punctuation
 * between them. A split/join with no complete consumed block stays one structural replacement.
 */
function separateBlocks(B: Side, S: Side, hunks: Hunk[]): Hunk[] {
  const complete = (side: Side, from: number, to: number): [number, number] => {
    const block = from === side.toks.length ? side.blocks.length : side.blockOf[from];
    const interior = side.starts[block] < from;
    const first = block + (interior ? 1 : 0);
    const end = to === side.toks.length ? side.blocks.length : side.blockOf[to];
    if (first < end) return [side.starts[first], side.starts[end]];
    // With no complete block, a partial tail belongs before the complete run on the other side;
    // a partial block starting at its boundary belongs after it (the next aligned word's prefix).
    return interior ? [to, to] : [from, from];
  };
  const out: Hunk[] = [];
  for (const h of hunks) {
    if (h.from === h.to || !h.ins.length) {
      out.push(h);
      continue;
    }
    const sto = h.sfrom + h.ins.length;
    const [b0, b1] = complete(B, h.from, h.to);
    const [s0, s1] = complete(S, h.sfrom, sto);
    if (b0 === b1 && s0 === s1) {
      out.push(h);
      continue;
    }
    let b = h.from;
    let s = h.sfrom;
    const start = out.length;
    for (const [to, send] of [
      [b0, s0],
      [b1, s1],
      [h.to, sto],
    ]) {
      if (to > b || send > s) {
        const prev = out.length > start ? out.at(-1) : undefined;
        // One pure insertion at a position (or contiguous deletion) remains one edit. In particular,
        // an added block plus a split's new paragraph start must not become competing insertions.
        if (prev && ((prev.from === prev.to && b === to) || (!prev.ins.length && s === send))) {
          prev.to = to;
          prev.ins = S.toks.slice(prev.sfrom, send);
        } else out.push({ from: b, to, sfrom: s, ins: S.toks.slice(s, send) });
      }
      b = to;
      s = send;
    }
  }
  return out;
}

/** Keep small split/join gaps whole. Large unmatched runs pair in order, not by token search. */
function boundedGap(
  B: Side,
  b0: number,
  b1: number,
  S: Side,
  s0: number,
  s1: number,
  out: UnitHunk[],
) {
  if (b1 - b0 === 1 && s1 - s0 === 1) {
    unitHunks(B, b0, b1, S, s0, s1, out);
    return;
  }
  if (
    B.starts[b1] - B.starts[b0] <= ANCHOR_GAP_TOKENS &&
    S.starts[s1] - S.starts[s0] <= ANCHOR_GAP_TOKENS
  ) {
    unitHunks(B, b0, b1, S, s0, s1, out);
    return;
  }
  if (b1 - b0 !== s1 - s0) {
    const paired = anchorGap(B, b0, b1, S, s0, s1, 0.4);
    if (paired.length > 1) {
      for (const [b, be, s, se] of paired)
        if (b < be || s < se) boundedGap(B, b, be, S, s, se, out);
      return;
    }
  }
  // No strong anchors survived. Position is only a boundary for work, not evidence of equal text:
  // every token still participates in either a bounded diff or a whole-paragraph replacement.
  while (b0 < b1 && s0 < s1) {
    unitHunks(B, b0, b0 + 1, S, s0, s0 + 1, out);
    b0++;
    s0++;
  }
  if (b0 < b1 || s0 < s1) unitHunks(B, b0, b1, S, s0, s1, out);
}

/**
 * Token diff of one gap. Content (words, punctuation, inline and whole-block atoms) is aligned first;
 * a paragraph start then pairs with the start of the side paragraph its first aligned word landed in.
 * Every paragraph start has the same token, so aligning them as ordinary tokens lets a diff pair
 * unrelated paragraphs, or read a split as "this word left the paragraph".
 */
function tokenHunks(B: Side, b0: number, b1: number, S: Side, s0: number, s1: number, out: Hunk[]) {
  const bt = B.toks;
  const st = S.toks;
  if (b0 === b1 || s0 === s1) {
    out.push({ from: b0, to: b1, sfrom: s0, ins: st.slice(s0, s1) });
    return;
  }
  const content = (ts: Tok[], i: number, j: number) => {
    const idx: number[] = [];
    for (let k = i; k < j; k++) if (ts[k].kind !== "block") idx.push(k);
    return idx;
  };
  const bc = content(bt, b0, b1);
  const sc = content(st, s0, s1);
  // Words first (they rarely repeat nearby), then punctuation between matched words, so a full stop
  // can't anchor a word to the wrong sentence.
  const strong = (t: Tok) => t.kind !== "text" || t.word;
  // Words align by text alone, so a word that only gained a mark stays paired with itself.
  const diffIdx = (
    xs: number[],
    ys: number[],
    key: (t: Tok) => string,
  ): Array<[number, number]> => {
    if (!xs.length || !ys.length) return [];
    const res: Array<[number, number]> = [];
    let x = 0;
    let y = 0;
    for (const [op, n] of diffKeys(
      xs.map((k) => key(bt[k])),
      ys.map((k) => key(st[k])),
    )) {
      if (op === DIFF_EQUAL) for (let k = 0; k < n; k++) res.push([xs[x + k], ys[y + k]]);
      if (op !== DIFF_INSERT) x += n;
      if (op !== DIFF_DELETE) y += n;
    }
    return res;
  };
  const wordMatches = diffIdx(
    bc.filter((k) => strong(bt[k])),
    sc.filter((k) => strong(st[k])),
    coreKey,
  );
  const matches: Array<[number, number]> = [];
  // Punctuation indices once per side, then monotone cursors: each matched word's span is a slice.
  const weakB = bc.filter((k) => !strong(bt[k]));
  const weakS = sc.filter((k) => !strong(st[k]));
  let cb = 0;
  let cs = 0;
  let pbx = b0 - 1;
  let psy = s0 - 1;
  for (const pair of [...wordMatches, [b1, s1] as [number, number]]) {
    while (cb < weakB.length && weakB[cb] <= pbx) cb++;
    while (cs < weakS.length && weakS[cs] <= psy) cs++;
    let eb = cb;
    let es = cs;
    while (eb < weakB.length && weakB[eb] < pair[0]) eb++;
    while (es < weakS.length && weakS[es] < pair[1]) es++;
    matches.push(...diffIdx(weakB.slice(cb, eb), weakS.slice(cs, es), (t) => t.key));
    cb = eb;
    cs = es;
    if (pair[0] < b1) matches.push(pair);
    [pbx, psy] = pair;
  }
  // Paragraph starts: pair with the side paragraph holding the block's first aligned content.
  const all: Array<[number, number]> = [];
  let mi = 0;
  let lastSide = s0 - 1;
  for (let i = b0; i < b1; i++) {
    if (bt[i].kind === "block") {
      const end = B.starts[B.blockOf[i] + 1];
      let k = mi;
      while (k < matches.length && matches[k][0] < i) k++;
      if (k < matches.length && matches[k][0] < end) {
        const sp = S.starts[S.blockOf[matches[k][1]]];
        if (sp > lastSide && sp >= s0 && st[sp].kind === "block") {
          all.push([i, sp]);
          lastSide = sp;
        }
      } else if (end === i + 1) {
        // An empty paragraph pairs with the next unclaimed empty side paragraph before the next match.
        const limit = k < matches.length ? matches[k][1] : s1;
        for (let sp = lastSide + 1; sp < limit; sp++)
          if (st[sp].key === bt[i].key && S.starts[S.blockOf[sp] + 1] === sp + 1) {
            all.push([i, sp]);
            lastSide = sp;
            break;
          }
      }
      continue;
    }
    while (mi < matches.length && matches[mi][0] < i) mi++;
    if (mi < matches.length && matches[mi][0] === i) {
      all.push(matches[mi]);
      lastSide = matches[mi][1];
    }
  }
  // Pairs whose tokens differ (a word that changed marks, a paragraph that became a heading) are
  // one-token replacements of their own.
  let pb = b0;
  let ps = s0;
  for (const [mx, my] of [...all, [b1, s1] as [number, number]]) {
    if (mx > pb || my > ps) out.push({ from: pb, to: mx, sfrom: ps, ins: st.slice(ps, my) });
    if (mx < b1 && bt[mx].key !== st[my].key)
      out.push({ from: mx, to: mx + 1, sfrom: my, ins: [st[my]] });
    pb = mx + 1;
    ps = my + 1;
  }
}

/**
 * A pure insertion or deletion next to equal tokens can sit at several equivalent places. Pick one
 * by rule so both sides' diffs agree: whole blocks at block boundaries when possible, else leftmost.
 */
function canonicalize(bt: Tok[], st: Tok[], hunks: Hunk[]) {
  const boundary = (p: number) => p === bt.length || isBlockTok(bt[p]);
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const lo = i > 0 ? hunks[i - 1].to : 0;
    const hi = i + 1 < hunks.length ? hunks[i + 1].from : bt.length;
    if (h.from === h.to && h.ins.length) {
      const n = h.ins.length;
      let p = h.from;
      let sf = h.sfrom;
      while (p - 1 >= lo && st[sf + n - 1].key === bt[p - 1].key) {
        p--;
        sf--;
      }
      const cands: Array<[number, number]> = [[p, sf]];
      while (p < hi && st[sf].key === bt[p].key) {
        p++;
        sf++;
        cands.push([p, sf]);
      }
      const best = cands.find(([q, s]) => boundary(q) && isBlockTok(st[s])) ?? cands[0];
      h.from = h.to = best[0];
      h.sfrom = best[1];
      h.ins = st.slice(best[1], best[1] + n);
    } else if (!h.ins.length && h.from < h.to) {
      const n = h.to - h.from;
      let p = h.from;
      let sf = h.sfrom;
      while (p - 1 >= lo && bt[p - 1].key === bt[p + n - 1].key) {
        p--;
        sf--;
      }
      const cands: Array<[number, number]> = [[p, sf]];
      while (p + n < hi && bt[p].key === bt[p + n].key) {
        p++;
        sf++;
        cands.push([p, sf]);
      }
      const best = cands.find(([q]) => isBlockTok(bt[q]) && boundary(q + n)) ?? cands[0];
      h.from = best[0];
      h.to = best[0] + n;
      h.sfrom = best[1];
    }
  }
}

/**
 * Splits a replacement where some new tokens are old ones with other marks (or other whitespace):
 * those become one-token replacements and the rest plain insertions and deletions, so a bolded word
 * and the sentence typed after it are two changes, not one.
 */
function refine(bt: Tok[], hunks: Hunk[]): Hunk[] {
  const out: Hunk[] = [];
  for (const h of hunks) {
    const n = h.to - h.from;
    const m = h.ins.length;
    if (!n || !m || n > ANCHOR_GAP_TOKENS || m > ANCHOR_GAP_TOKENS) {
      out.push(h);
      continue;
    }
    const a = Array.from({ length: n }, (_, k) => coreKey(bt[h.from + k]));
    const b = h.ins.map(coreKey);
    const matches = equalOrderedMatches(a, b);
    if (!matches.length) {
      out.push(h);
      continue;
    }
    let i = 0;
    let j = 0;
    // Everything between two matches is one plain replacement; a match whose marks differ is its own.
    const gap = (toI: number, toJ: number) => {
      if (toI > i || toJ > j)
        out.push({
          from: h.from + i,
          to: h.from + toI,
          sfrom: h.sfrom + j,
          ins: h.ins.slice(j, toJ),
        });
    };
    for (const [mi, mj] of matches) {
      gap(mi, mj);
      if (bt[h.from + mi].key !== h.ins[mj].key)
        out.push({ from: h.from + mi, to: h.from + mi + 1, sfrom: h.sfrom + mj, ins: [h.ins[mj]] });
      i = mi + 1;
      j = mj + 1;
    }
    gap(n, m);
  }
  return out;
}
