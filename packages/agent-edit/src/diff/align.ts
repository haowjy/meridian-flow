/**
 * Align two block sequences by their correspondence: each pair, with its split and join pieces, is a
 * unit, and only a unit is token-diffed. Units are cached, so a new node re-diffs only its unit
 * while the paragraph pass relocates every cached result. A deterministic size cap guards an
 * oversized unit, never the chapter.
 *
 * Within a unit, words align before punctuation, and paragraph starts follow their first matched word.
 * That keeps a small split or join reading as one edit instead of unrelated paragraph replacements.
 * Blocks between units are a removed run and an added run.
 */
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import { equalOrderedMatches } from "../ordered-matching.js";
import type { Correspondence } from "./correspond.js";
import { type Hunk, posMap } from "./hunks.js";
import {
  blockKey,
  buildSide,
  coreKey,
  diffKeys,
  isBlockTok,
  type Side,
  type Tok,
} from "./tokens.js";

export interface Alignment {
  hunks: Hunk[];
  baseToSide: Int32Array; // base block -> equal side block, else -1
  pos: Int32Array; // base token -> side token outside hunks, else -1
}

export function align(B: Side, S: Side, corr: Correspondence): Alignment {
  const baseToSide = new Int32Array(B.blocks.length).fill(-1);
  const hunks: Hunk[] = [];
  let pb = 0;
  let ps = 0;
  // A removed run and an added run between two units are not each other: a removal, then an addition
  // after it, so a side that removed the same blocks and added others keeps its additions.
  const between = (b1: number, s1: number) => {
    if (pb < b1)
      hunks.push({
        from: B.starts[pb],
        to: B.starts[b1],
        sfrom: S.starts[ps],
        sto: S.starts[ps],
        ins: [],
      });
    if (ps < s1)
      hunks.push({
        from: B.starts[b1],
        to: B.starts[b1],
        sfrom: S.starts[ps],
        sto: S.starts[s1],
        ins: S.toks.slice(S.starts[ps], S.starts[s1]),
      });
  };
  for (let i = 0; i < B.blocks.length; i++) {
    const j = corr.partner[i];
    // Unpaired or moved: left as removed and added.
    if (j < 0 || corr.moved.has(i) || j < ps || i < pb) continue;
    let [u0, u1, v0, v1] = [i, i + 1, j, j + 1];
    while (u0 > pb && corr.oldPiece[u0 - 1] === i) u0--;
    while (u1 < B.blocks.length && corr.oldPiece[u1] === i) u1++;
    while (v0 > ps && corr.nextPiece[v0 - 1] === j) v0--;
    while (v1 < S.blocks.length && corr.nextPiece[v1] === j) v1++;
    between(u0, v0);
    if (u1 - u0 === 1 && v1 - v0 === 1 && blockKey(B.blocks[i]) === blockKey(S.blocks[j]))
      baseToSide[i] = j;
    else unitHunks(B, u0, u1, S, v0, v1, hunks);
    pb = u1;
    ps = v1;
  }
  between(B.blocks.length, S.blocks.length);
  // One side's insertions at one point are one insertion.
  for (let k = hunks.length - 1; k > 0; k--) {
    const [a, b] = [hunks[k - 1], hunks[k]];
    if (a.from === a.to && b.from === b.to && a.from === b.from && a.sto === b.sfrom)
      hunks.splice(k - 1, 2, { ...a, sto: b.sto, ins: [...a.ins, ...b.ins] });
  }
  return { hunks, baseToSide, pos: posMap(B.toks.length, hunks) };
}

// 1,000 tokens preserves ordinary split/join units while capping Myers' quadratic search.
// Disjoint 1,000-word paragraphs measured 18–29 ms; 1,500 reached 128 ms (KF30 probe).
// Oversized paragraphs stay whole replacements.
const ANCHOR_GAP_TOKENS = 1000;

type UnitMemo = { next: WeakMap<object, UnitMemo>; hunks?: Hunk[] };
const units: UnitMemo = { next: new WeakMap() };
const sideBoundary = {};

/**
 * The ordered base nodes, a boundary, then the ordered draft nodes identify one unit. A weak trie
 * retains small multi-paragraph runs without retaining old documents; the boundary distinguishes
 * [a] → [b, c] from [a, b] → [c]. Cached offsets belong to the unit, not its place in the document.
 */
function unitHunks(B: Side, b0: number, b1: number, S: Side, s0: number, s1: number, out: Hunk[]) {
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
      hunks.push({
        from: 0,
        to: base.toks.length,
        sfrom: 0,
        sto: draft.toks.length,
        ins: draft.toks,
      });
    else tokenHunks(base, 0, base.toks.length, draft, 0, draft.toks.length, hunks);
    memo.hunks = separateBlocks(base, draft, refine(base.toks, hunks));
    canonicalize(base.toks, draft.toks, memo.hunks);
  }
  const relocate = (h: Hunk): Hunk => ({
    ...h,
    from: h.from + B.starts[b0],
    to: h.to + B.starts[b0],
    sfrom: h.sfrom + S.starts[s0],
    sto: h.sto + S.starts[s0],
  });
  for (const h of memo.hunks) out.push(relocate(h));
}

/**
 * An unmatched interval may include a paragraph's changed tail and whole removed/added blocks.
 * Keep complete blocks independent of partial edge blocks; pair complete replacements in order and
 * detach excess blocks. Refinement can expose a partial edge by retaining a leading block token,
 * so normalization runs after refinement. Splits/joins with no complete block stay whole.
 */
function separateBlocks(B: Side, S: Side, hunks: Hunk[]): Hunk[] {
  const blockAt = (side: Side, pos: number) =>
    pos === side.toks.length ? side.blocks.length : side.blockOf[pos];
  const complete = (side: Side, from: number, to: number): [number, number] => {
    const block = blockAt(side, from);
    const interior = side.starts[block] < from;
    const first = block + (interior ? 1 : 0);
    const end = blockAt(side, to);
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
    const [b0, b1] = complete(B, h.from, h.to);
    const [s0, s1] = complete(S, h.sfrom, h.sto);
    if (b0 === b1 && s0 === s1) {
      out.push(h);
      continue;
    }
    const paired = Math.min(blockAt(B, b1) - blockAt(B, b0), blockAt(S, s1) - blockAt(S, s0));
    const bp = paired ? B.starts[blockAt(B, b0) + paired] : b0;
    const sp = paired ? S.starts[blockAt(S, s0) + paired] : s0;
    let b = h.from;
    let s = h.sfrom;
    const start = out.length;
    for (const [to, send] of [
      [b0, s0],
      [bp, sp],
      [b1, s1],
      [h.to, h.sto],
    ]) {
      if (to > b || send > s) {
        const prev = out.length > start ? out.at(-1) : undefined;
        // One pure insertion at a position (or contiguous deletion) remains one edit. In particular,
        // an added block plus a split's new paragraph start must not become competing insertions.
        if (prev && ((prev.from === prev.to && b === to) || (!prev.ins.length && s === send))) {
          prev.to = to;
          prev.sto = send;
          prev.ins = S.toks.slice(prev.sfrom, send);
        } else out.push({ from: b, to, sfrom: s, sto: send, ins: S.toks.slice(s, send) });
      }
      b = to;
      s = send;
    }
  }
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
    out.push({ from: b0, to: b1, sfrom: s0, sto: s1, ins: st.slice(s0, s1) });
    return;
  }
  const content = (ts: Tok[], i: number, j: number) => {
    const idx: number[] = [];
    for (let k = i; k < j; k++) if (ts[k].kind !== "block") idx.push(k);
    return idx;
  };
  const bc = content(bt, b0, b1);
  const sc = content(st, s0, s1);
  // Blocks with the same id are the same block: their starts pair, and no word match may cross them.
  const idPairs = blockIdPairs(bt, b0, b1, st, s0, s1);
  const crossesPair = (b: number, s: number) =>
    idPairs.some(([pb, ps]) => (b < pb && s > ps) || (b > pb && s < ps));
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
  ).filter(([b, s]) => !crossesPair(b, s));
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
    matches.push(
      ...diffIdx(weakB.slice(cb, eb), weakS.slice(cs, es), (t) => t.key).filter(
        ([b, s]) => !crossesPair(b, s),
      ),
    );
    cb = eb;
    cs = es;
    if (pair[0] < b1) matches.push(pair);
    [pbx, psy] = pair;
  }
  // Paragraph starts: pair with the side paragraph holding the block's first aligned content.
  const all: Array<[number, number]> = [];
  let mi = 0;
  let lastSide = s0 - 1;
  const claimed = new Set(idPairs.map(([, sp]) => sp));
  for (let i = b0; i < b1; i++) {
    if (bt[i].kind === "block") {
      const byId = idPairs.find(([pb]) => pb === i);
      if (byId) {
        all.push(byId);
        lastSide = byId[1];
        continue;
      }
      const end = B.starts[B.blockOf[i] + 1];
      let k = mi;
      while (k < matches.length && matches[k][0] < i) k++;
      if (k < matches.length && matches[k][0] < end) {
        const sp = S.starts[S.blockOf[matches[k][1]]];
        if (sp > lastSide && sp >= s0 && st[sp].kind === "block" && !claimed.has(sp)) {
          all.push([i, sp]);
          lastSide = sp;
        }
      } else if (end === i + 1) {
        // An empty paragraph pairs with the next unclaimed empty side paragraph before the next match.
        const limit = k < matches.length ? matches[k][1] : s1;
        for (let sp = lastSide + 1; sp < limit; sp++)
          if (
            st[sp].key === bt[i].key &&
            !claimed.has(sp) &&
            S.starts[S.blockOf[sp] + 1] === sp + 1
          ) {
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
    if (mx > pb || my > ps)
      out.push({ from: pb, to: mx, sfrom: ps, sto: my, ins: st.slice(ps, my) });
    if (mx < b1 && bt[mx].key !== st[my].key)
      out.push({ from: mx, to: mx + 1, sfrom: my, sto: my + 1, ins: [st[my]] });
    pb = mx + 1;
    ps = my + 1;
  }
}

/**
 * The block starts of the two ranges that carry the same id, in order (a later one that would cross
 * an earlier is left out). Both ranges are one unit, so an id repeats at most by mistake: the first
 * block with it pairs.
 */
function blockIdPairs(bt: Tok[], b0: number, b1: number, st: Tok[], s0: number, s1: number) {
  const idAt = (t: Tok) => (t.kind === "block" ? (t.node.attrs.id as string | null) : null);
  const side = new Map<string, number>();
  for (let k = s0; k < s1; k++) {
    const id = idAt(st[k]);
    if (id != null && !side.has(id)) side.set(id, k);
  }
  const pairs: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (let k = b0; k < b1; k++) {
    const id = idAt(bt[k]);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    const sp = side.get(id);
    if (sp !== undefined && sp > (pairs.at(-1)?.[1] ?? s0 - 1)) pairs.push([k, sp]);
  }
  return pairs;
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
      h.sto = best[1] + n;
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
      h.sfrom = h.sto = best[1];
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
          sto: h.sfrom + toJ,
          ins: h.ins.slice(j, toJ),
        });
    };
    for (const [mi, mj] of matches) {
      gap(mi, mj);
      if (bt[h.from + mi].key !== h.ins[mj].key)
        out.push({
          from: h.from + mi,
          to: h.from + mi + 1,
          sfrom: h.sfrom + mj,
          sto: h.sfrom + mj + 1,
          ins: [h.ins[mj]],
        });
      i = mi + 1;
      j = mj + 1;
    }
    gap(n, m);
  }
  return out;
}
