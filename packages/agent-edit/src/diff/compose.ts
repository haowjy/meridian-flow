/**
 * Partial Apply and Discard as one pure operation on the hunks the writer saw.
 *
 * A selected set of hunks (the union of the chosen groups) becomes block-range patches. Each patch
 * covers the smallest block range, on both sides at once, that no hunk straddles, so unselected
 * hunks inside it are handled in the same patch and everything outside it is never touched.
 * Two hunks in one paragraph therefore compose jointly into one patch, never two overlapping ones.
 *
 * `apply` yields the base with the selected hunks applied. `discard` yields the draft with the
 * selected hunks reverted, which is the base with every other hunk applied.
 */
import { Fragment, type Node as PMNode, type Schema } from "prosemirror-model";
import { blocksEqual } from "./equal.js";
import { type BlockDiff, diffBlocks, type Hunk } from "./hunks.js";
import { rebase } from "./merge.js";
import { buildBlocks, isBlockTok, type Side, type Tok } from "./tokens.js";

export interface SpanPatch {
  base: { from: number; to: number }; // block indices [from, to) in the base
  draft: { from: number; to: number }; // block indices [from, to) in the draft
  blocks: PMNode[]; // the replacement: for "apply" it goes in the base, for "discard" in the draft
}

export type ComposeMode = "apply" | "discard";

interface Cut {
  k: number; // hunks before the cut
  b: number; // base token
  d: number; // draft token
}

const isStart = (s: Side, p: number) => p === s.toks.length || isBlockTok(s.toks[p]);
const blockIndex = (s: Side, p: number) => (p >= s.toks.length ? s.blocks.length : s.blockOf[p]);

export function composeHunks(
  schema: Schema,
  diff: BlockDiff,
  selected: Iterable<Hunk>,
  mode: ComposeMode,
): SpanPatch[] {
  const { base: B, draft: D, hunks } = diff;
  const chosen = new Set(selected);
  const selIdx: number[] = [];
  hunks.forEach((h, i) => {
    if (chosen.delete(h)) selIdx.push(i);
  });
  if (chosen.size)
    throw new RangeError("composeHunks: a selected hunk is not one of the diff's hunks");
  if (!selIdx.length) return [];
  const take = new Set(selIdx.map((i) => hunks[i]));

  const delta = (k: number) =>
    k === 0 ? 0 : hunks[k - 1].sfrom + hunks[k - 1].ins.length - hunks[k - 1].to;
  const gapStart = (k: number) => (k === 0 ? 0 : hunks[k - 1].to);
  const gapEnd = (k: number) => (k === hunks.length ? B.toks.length : hunks[k].from);

  // Greatest cut with hunks[s..] after it: a base block start whose draft counterpart is also a block start.
  const leftCut = (s: number): Cut => {
    for (let k = s; k >= 0; k--) {
      const lo = gapStart(k);
      for (let p = gapEnd(k); p >= lo; ) {
        const b = isStart(B, p) ? p : B.starts[B.blockOf[p]];
        if (b < lo) break;
        const d = b + delta(k);
        if (isStart(D, d)) return { k, b, d };
        p = b - 1;
      }
    }
    return { k: 0, b: 0, d: 0 };
  };
  // Smallest cut with hunks[..s] before it.
  const rightCut = (s: number): Cut => {
    for (let k = s + 1; k <= hunks.length; k++) {
      const hi = gapEnd(k);
      for (let p = gapStart(k); p <= hi; ) {
        const b = isStart(B, p) ? p : B.starts[B.blockOf[p] + 1];
        if (b > hi) break;
        const d = b + delta(k);
        if (isStart(D, d)) return { k, b, d };
        p = b + 1;
      }
    }
    return { k: hunks.length, b: B.toks.length, d: D.toks.length };
  };

  const regions: Array<{ l: Cut; r: Cut }> = [];
  for (const s of selIdx) {
    const last = regions.at(-1);
    if (last && s < last.r.k) continue;
    const l = leftCut(s);
    const r = rightCut(s);
    if (last && l.b < last.r.b) last.r = r;
    else regions.push({ l, r });
  }

  const patches: SpanPatch[] = [];
  for (const { l, r } of regions) {
    const out: Tok[] = [];
    let at = l.b;
    let adopt = -1; // base token right after an applied hunk: it takes its leading space from the draft
    const copy = (to: number) => {
      for (; at < to; at++) {
        const t = B.toks[at];
        const j = diff.pos[at];
        const d = at === adopt && j >= 0 ? D.toks[j] : undefined;
        out.push(
          t.kind === "text" && d?.kind === "text" ? { ...t, ws: d.ws, wsMarks: d.wsMarks } : t,
        );
      }
    };
    for (let k = l.k; k < r.k; k++) {
      const h = hunks[k];
      copy(h.from);
      if (take.has(h) === (mode === "apply")) {
        out.push(...h.ins);
        adopt = h.to;
        at = h.to;
      }
    }
    copy(r.b);
    patches.push({
      base: { from: blockIndex(B, l.b), to: blockIndex(B, r.b) },
      draft: { from: blockIndex(D, l.d), to: blockIndex(D, r.d) },
      blocks: buildBlocks(schema, out, { allowEmpty: true }).blocks,
    });
  }
  return patches;
}

/** Applies patches to a block list, last first so earlier indices stay valid (an insertion at a block applies after a replacement of it). */
export function applySpanPatches(
  blocks: readonly PMNode[],
  patches: readonly SpanPatch[],
  side: "base" | "draft",
): PMNode[] {
  const out = blocks.slice();
  for (const p of [...patches].sort(
    (a, b) => b[side].from - a[side].from || b[side].to - a[side].to,
  ))
    out.splice(p[side].from, p[side].to - p[side].from, ...p.blocks);
  return out;
}

/** The shared server write and optimistic fold of a frozen Apply click (O → P). */
export function applyBase(
  schema: Schema,
  committed: readonly PMNode[],
  optimistic: readonly PMNode[],
  patched: readonly PMNode[],
): readonly PMNode[] {
  return blocksEqual(optimistic, committed)
    ? patched
    : rebase(schema, optimistic, committed, patched).blocks;
}

/** One block-range delta from the room's base to the base the writer saw, not a chain of clicks. */
export function baseViewDelta(
  schema: Schema,
  committed: readonly PMNode[],
  optimistic: readonly PMNode[],
): SpanPatch[] {
  if (blocksEqual(committed, optimistic)) return [];
  const diff = diffBlocks(committed, optimistic);
  return composeHunks(schema, diff, diff.hunks, "apply");
}

export type SpanPatchError =
  | { kind: "invalid_range"; patch: number }
  | { kind: "overlapping_ranges"; patch: number }
  | { kind: "invalid_blocks" };

/** Checks the applied side before a decoded request reaches composition; never mutates its inputs. */
export function validateSpanPatches(
  schema: Schema,
  blocks: readonly PMNode[],
  patches: readonly SpanPatch[],
  side: "base" | "draft" = "base",
): SpanPatchError | null {
  const ordered = patches.map((patch, index) => ({ patch, index }));
  for (const { patch, index } of ordered) {
    const range = patch[side];
    if (
      !range ||
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      range.from < 0 ||
      range.to < range.from ||
      range.to > blocks.length
    )
      return { kind: "invalid_range", patch: index };
  }
  ordered.sort(
    (a, b) => a.patch[side].from - b.patch[side].from || a.patch[side].to - b.patch[side].to,
  );
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1].patch[side];
    const current = ordered[i].patch[side];
    // Two insertions at one boundary have no unique order in a wire delta.
    if (current.from < previous.to || current.from === previous.from)
      return { kind: "overlapping_ranges", patch: ordered[i].index };
  }
  try {
    const result = applySpanPatches(blocks, patches, side);
    for (const block of result) {
      if (block.type.schema !== schema || !block.isBlock) return { kind: "invalid_blocks" };
      block.check();
    }
    // Empty block lists are the kernel's empty document, filled by buildBlocks on write.
    if (result.length && !schema.topNodeType.validContent(Fragment.fromArray(result)))
      return { kind: "invalid_blocks" };
  } catch {
    return { kind: "invalid_blocks" };
  }
  return null;
}
