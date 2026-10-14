/**
 * Anchored alignment of two token sides. Equal blocks are anchors (Myers over one code per block key);
 * each gap between anchors is token-diffed on its own, and an empty gap costs nothing. So the cost
 * follows the size of the edits, not the size of the document.
 *
 * Inside a gap, words align first (they rarely repeat nearby), then punctuation between matched words,
 * then paragraph starts pair with the paragraph their first aligned word landed in. That reads a split
 * or a join as ordinary hunks over block-start tokens.
 */
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Node as PMNode } from "prosemirror-model";
import { weightedOrderedMatches } from "../ordered-matching.js";
import { type Hunk, posMap } from "./hunks.js";
import {
  blockKey,
  blockWords,
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
  const hunks: Hunk[] = [];
  let bi = 0;
  let si = 0;
  let gb = 0;
  let gs = 0;
  const gap = () => {
    if (gb === bi && gs === si) return;
    for (const [b0, b1, s0, s1] of anchorGap(B, gb, bi, S, gs, si)) {
      if (b0 === b1 && s0 === s1) continue;
      tokenHunks(B, B.starts[b0], B.starts[b1], S, S.starts[s0], S.starts[s1], hunks);
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
  canonicalize(B.toks, S.toks, hunks);
  const fine = refine(B.toks, hunks);
  hunks.length = 0;
  hunks.push(...fine);
  return { hunks, baseToSide, sideToBase, pos: posMap(B.toks.length, hunks) };
}

/**
 * A large gap (most paragraphs changed) would make one token diff over thousands of tokens. Split it
 * at paragraphs that are clearly the same paragraph edited in place (80% of words shared, in order,
 * near the same position), so each token diff stays paragraph-sized. Small gaps stay whole: the
 * content-first diff over a gap is what reads a split or a join as one.
 */
const ANCHOR_GAP_TOKENS = 1500;
const ANCHOR_SIMILAR = 0.8;
const ANCHOR_BAND = 40;

// Repeated recomputes over retained nodes ask the same pairs again; nodes are immutable.
const similarityMemo = new WeakMap<PMNode, WeakMap<PMNode, number>>();
function cachedSimilarity(a: PMNode, b: PMNode): number {
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
function anchorGap(
  B: Side,
  gb: number,
  bi: number,
  S: Side,
  gs: number,
  si: number,
): Array<[number, number, number, number]> {
  const whole: Array<[number, number, number, number]> = [[gb, bi, gs, si]];
  if (
    B.starts[bi] - B.starts[gb] < ANCHOR_GAP_TOKENS &&
    S.starts[si] - S.starts[gs] < ANCHOR_GAP_TOKENS
  )
    return whole;
  if (bi - gb < 2 || si - gs < 2) return whole;
  const sets = new Map<PMNode, Set<string>>();
  const setOf = (n: PMNode) => {
    let x = sets.get(n);
    if (!x) {
      x = new Set(blockWords(n));
      sets.set(n, x);
    }
    return x;
  };
  const ratio = (si - gs) / (bi - gb);
  const w = (x: number, y: number) => {
    if (Math.abs(y - gs - (x - gb) * ratio) > ANCHOR_BAND) return 0;
    const a = B.blocks[x];
    const b = S.blocks[y];
    if (a.type !== b.type || !a.isTextblock) return 0;
    const sa = setOf(a);
    const sb = setOf(b);
    if (Math.min(sa.size, sb.size) < ANCHOR_SIMILAR * Math.max(sa.size, sb.size)) return 0;
    let common = 0;
    for (const t of sa) if (sb.has(t)) common++;
    if (common < ANCHOR_SIMILAR * Math.max(sa.size, sb.size)) return 0;
    return cachedSimilarity(a, b) >= ANCHOR_SIMILAR ? 1 : 0;
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
    if (!n || !m || n * m > 250_000) {
      out.push(h);
      continue;
    }
    const a = Array.from({ length: n }, (_, k) => coreKey(bt[h.from + k]));
    const b = h.ins.map(coreKey);
    const best = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        best[i][j] =
          a[i] === b[j] ? best[i + 1][j + 1] + 1 : Math.max(best[i + 1][j], best[i][j + 1]);
    if (!best[0][0]) {
      out.push(h);
      continue;
    }
    let i = 0;
    let j = 0;
    let cur: Hunk | null = null;
    const close = () => {
      if (cur) out.push(cur);
      cur = null;
    };
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        close();
        if (bt[h.from + i].key !== h.ins[j].key)
          out.push({ from: h.from + i, to: h.from + i + 1, sfrom: h.sfrom + j, ins: [h.ins[j]] });
        i++;
        j++;
      } else if (j >= m || (i < n && best[i + 1][j] >= best[i][j + 1])) {
        cur ??= { from: h.from + i, to: h.from + i, sfrom: h.sfrom + j, ins: [] };
        cur.to = h.from + i + 1;
        i++;
      } else {
        cur ??= { from: h.from + i, to: h.from + i, sfrom: h.sfrom + j, ins: [] };
        cur.ins.push(h.ins[j]);
        j++;
      }
    }
    close();
  }
  return out;
}
