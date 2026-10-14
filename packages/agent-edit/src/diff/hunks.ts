/**
 * Hunks: what changed between two token sides, as the writer reads it.
 *
 * `align` finds token-level hunks; this file adds whitespace-only differences, classifies hunks, and
 * runs the semantic cleanup (D5) that turns word salad into one replacement. Review uses the cleaned
 * hunks; the rebase merge uses `align`'s uncleaned ones to keep word precision.
 */
import type { Node as PMNode } from "prosemirror-model";
import { type Alignment, align } from "./align.js";
import { buildSide, coreKey, isBlockTok, type Side, type Tok } from "./tokens.js";

export interface Hunk {
  from: number; // base token range replaced
  to: number;
  sfrom: number; // side token index where `ins` starts
  ins: Tok[];
  sidx?: number[]; // side index of each `ins` token when they aren't contiguous from `sfrom` (merge only)
}

/** "format" changes marks or a block's type, "whitespace" only spacing, "text" anything else. */
export type HunkKind = "text" | "format" | "whitespace";

/** Base token -> side token outside hunks, else -1. */
export function posMap(n: number, hunks: readonly Hunk[]): Int32Array {
  const pos = new Int32Array(n).fill(-1);
  let b0 = 0;
  let s0 = 0;
  for (const h of hunks) {
    while (b0 < h.from) pos[b0++] = s0++;
    b0 = h.to;
    s0 = h.sfrom + h.ins.length;
  }
  while (b0 < n) pos[b0++] = s0++;
  return pos;
}

const sameMarks = (a: readonly { eq(o: never): boolean }[], b: readonly unknown[]) =>
  a.length === b.length && a.every((m, i) => m.eq(b[i] as never));
const wsMarksOf = (t: Tok & { kind: "text" }) => t.wsMarks ?? t.marks;

/**
 * Equal-keyed tokens whose leading whitespace differs, where the two tokens before them are also
 * neighbours on both sides. Anywhere else the whitespace belongs to the hunk beside it (a split turns
 * " word" into "word"). Only blocks that are not equal can differ, so anchors left in place cost nothing.
 */
function whitespaceHunks(B: Side, S: Side, al: Alignment): Hunk[] {
  const out: Hunk[] = [];
  const bt = B.toks;
  const st = S.toks;
  for (let b = 0; b < B.blocks.length; b++) {
    const anchor = al.baseToSide[b];
    // An anchor equal in place has nothing to scan. Canonicalizing may have slid it onto a lookalike block.
    if (anchor >= 0 && al.pos[B.starts[b]] === S.starts[anchor]) continue;
    for (let i = B.starts[b]; i < B.starts[b + 1]; i++) {
      const j = al.pos[i];
      const x = bt[i];
      if (j < 0 || x.kind !== "text" || i === 0 || al.pos[i - 1] !== j - 1) continue;
      const y = st[j] as typeof x;
      if (x.ws === y.ws && (!x.ws || sameMarks(wsMarksOf(x), wsMarksOf(y)))) continue;
      out.push({ from: i, to: i + 1, sfrom: j, ins: [y] });
    }
  }
  return out;
}

export function hunkKind(bt: readonly Tok[], h: Hunk): HunkKind {
  const n = h.to - h.from;
  if (!n || n !== h.ins.length) return "text";
  let differs = false;
  for (let k = 0; k < n; k++) {
    const x = bt[h.from + k];
    const y = h.ins[k];
    if (x.kind === "block" && y.kind === "block") {
      differs ||= x.key !== y.key;
      continue;
    }
    if (coreKey(x) !== coreKey(y) || x.kind !== y.kind) return "text";
    differs ||= x.key !== y.key;
  }
  return differs ? "format" : "whitespace";
}

/**
 * diff-match-patch's cleanupSemantic rule in token units: an equality between two hunks is absorbed
 * into one replacement when it is no longer than either neighbouring edit. An equality holding a
 * block-start token is never absorbed, so a change never crosses a paragraph break by cleanup.
 */
export function cleanupHunks(
  hunks: readonly Hunk[],
  bt: readonly Tok[],
  st: readonly Tok[],
): Hunk[] {
  const size = (h: Hunk) => Math.max(h.to - h.from, h.ins.length);
  let cur = hunks.slice();
  for (let changed = true; changed; ) {
    changed = false;
    const out: Hunk[] = [];
    for (const h of cur) {
      const prev = out.at(-1);
      if (prev && absorbable(prev, h)) {
        out[out.length - 1] = {
          from: prev.from,
          to: h.to,
          sfrom: prev.sfrom,
          ins: st.slice(prev.sfrom, h.sfrom + h.ins.length) as Tok[],
        };
        changed = true;
      } else out.push(h);
    }
    cur = out;
  }
  return cur;

  function absorbable(a: Hunk, b: Hunk): boolean {
    const eq = b.from - a.to;
    if (eq > size(a) || eq > size(b)) return false;
    for (let i = a.to; i < b.from; i++) if (isBlockTok(bt[i])) return false;
    return true;
  }
}

/** Two documents' difference: both token sides, review hunks (cleaned, whitespace included) and the map between them. */
export interface BlockDiff {
  base: Side;
  draft: Side;
  hunks: Hunk[];
  pos: Int32Array; // base token -> draft token outside hunks, else -1
  alignment: Alignment; // uncleaned, for callers that need word precision
}

export function diffBlocks(
  base: readonly PMNode[],
  draft: readonly PMNode[],
  opts: { cleanup?: boolean } = {},
): BlockDiff {
  const B = buildSide(base);
  const D = buildSide(draft);
  const alignment = align(B, D);
  let hunks = alignment.hunks;
  const ws = whitespaceHunks(B, D, alignment);
  if (ws.length) hunks = [...hunks, ...ws].sort((x, y) => x.from - y.from || x.to - y.to);
  if (opts.cleanup !== false) hunks = cleanupHunks(hunks, B.toks, D.toks);
  return { base: B, draft: D, hunks, pos: posMap(B.toks.length, hunks), alignment };
}
