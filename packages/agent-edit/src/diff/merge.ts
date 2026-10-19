/**
 * The content rebase: a pure three-way merge of base, live and draft top-level blocks. It brings live's
 * newer edits into a Work draft (and, with the patch as the draft side, writes an Apply into live).
 *
 * Nothing relates the sides' Yjs items; the tokens of each side are aligned to base, paragraph moves are
 * lifted so the other side's edits travel with the paragraph (`merge-order.ts`), and the two hunk lists
 * are merged (`merge-hunks.ts`, `merge-settle.ts`). Hunks from one side apply. Overlapping hunks with
 * equal results apply once. Insertions at one point keep both (live first). Anything else is a
 * conflict: the draft's version stays, so the conflict shows in review as diff(new base = live, draft).
 * It works on `align`'s uncleaned hunks (D5) for word precision. No Yjs here: the minimal Yjs writer is
 * `writer.ts`.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";
import { align } from "./align.js";
import type { Hunk } from "./hunks.js";
import { posMap } from "./hunks.js";
import {
  applyWithin,
  BASE,
  DRAFT,
  draftAbsorbsLive,
  dropMovedText,
  isSubsequence,
  LIVE,
  type MergedTok,
  mergeMarks,
  overlaps,
  peel,
  reslide,
  sameTokens,
} from "./merge-hunks.js";
import { mergeOrder } from "./merge-order.js";
import { settleWhitespace, unionInsertions } from "./merge-settle.js";
import { buildBlocks, buildSide, type Side, type Tok, tokenizeBlock } from "./tokens.js";

export interface Conflict {
  kind: "overlap" | "moved-text" | "move";
  baseIds: number[]; // original base block indices the conflict covers
  base: Tok[];
  live: Tok[];
  draft: Tok[];
}

export interface RebaseOptions {
  /** One optional tag per token, used only when aligning base to draft. */
  identity?: { base: readonly (string | undefined)[]; draft: readonly (string | undefined)[] };
}

export interface RebaseResult {
  /** Settled tokens; origin indices address the original input sides, even after paragraph moves. */
  merged: MergedTok[];
  /** Original base token to original live token outside live hunks, else -1. */
  baseToLive: Int32Array;
  blocks: PMNode[]; // the new draft
  conflicts: Conflict[]; // where both sides changed the same text; the draft's version is in `blocks`
  orderConflict: boolean; // the two sides' paragraph moves admit no single order; the draft's order won
}

/** Base tokens between two one-sided changes checked for being one change the diffs placed differently. */
const COALESCE_WINDOW = 3;

/** Hunks from both sides that touch the same base tokens `lo..hi`. */
interface Cluster {
  lo: number;
  hi: number;
  live: Hunk[];
  draft: Hunk[];
}

/** Live and draft hunks sorted by position, grouped into clusters of hunks that overlap each other. */
function clusterHunks(liveHunks: Hunk[], draftHunks: Hunk[], baseToks: Tok[]): Cluster[] {
  const all = [
    ...liveHunks.map((hunk) => ({ hunk, isLive: true })),
    ...draftHunks.map((hunk) => ({ hunk, isLive: false })),
  ].sort((x, y) => x.hunk.from - y.hunk.from || x.hunk.to - y.hunk.to || (x.isLive ? -1 : 1));
  const clusters: Cluster[] = [];
  for (const { hunk, isLive } of all) {
    const current = clusters.at(-1);
    const otherSide = current && (isLive ? current.draft : current.live);
    if (current && otherSide?.some((h) => overlaps(h, hunk, baseToks))) {
      (isLive ? current.live : current.draft).push(hunk);
      current.lo = Math.min(current.lo, hunk.from);
      current.hi = Math.max(current.hi, hunk.to);
    } else
      clusters.push({
        lo: hunk.from,
        hi: hunk.to,
        live: isLive ? [hunk] : [],
        draft: isLive ? [] : [hunk],
      });
  }
  return clusters;
}

const isPureInsert = (c: Cluster) => [...c.live, ...c.draft].every((h) => h.from === h.to);

/**
 * Two one-sided changes a few equal tokens apart may be one change the two diffs placed differently
 * (repeated block starts make that common), or a change and its extension. If one side's text for the
 * window carries the other's change, that text, kept once; otherwise null.
 */
function coalesce(first: Cluster, second: Cluster, baseToks: Tok[]): MergedTok[] | null {
  const liveThenDraft =
    first.live.length && !first.draft.length && second.draft.length && !second.live.length;
  const draftThenLive =
    first.draft.length && !first.live.length && second.live.length && !second.draft.length;
  if (second.lo - first.hi > COALESCE_WINDOW || !(liveThenDraft || draftThenLive)) return null;
  const liveHunks = [...first.live, ...second.live];
  const draftHunks = [...first.draft, ...second.draft];
  const liveVersion = applyWithin(baseToks, first.lo, second.hi, liveHunks, LIVE);
  const draftVersion = applyWithin(baseToks, first.lo, second.hi, draftHunks, DRAFT);
  const inserts = isPureInsert(first) && isPureInsert(second);
  if (inserts && isSubsequence(liveVersion, draftVersion)) return draftVersion;
  if (inserts && isSubsequence(draftVersion, liveVersion)) return liveVersion;
  return draftAbsorbsLive(liveVersion, draftVersion, liveHunks, baseToks);
}

export function rebase(
  schema: Schema,
  base: readonly PMNode[],
  live: readonly PMNode[],
  draft: readonly PMNode[],
  options: RebaseOptions = {},
): RebaseResult {
  const original = [buildSide(base), buildSide(live), buildSide(draft)];
  const permutation = (side: Side, origin: Side): number[] => {
    const available = new Map<PMNode, number[]>();
    origin.blocks.forEach((node, i) => {
      const indices = available.get(node) ?? [];
      indices.push(i);
      available.set(node, indices);
    });
    return side.blocks.flatMap((node, i) => {
      const block = available.get(node)?.shift();
      if (block === undefined) throw new Error("Rebase order lost an input block");
      return Array.from(
        { length: side.starts[i + 1] - side.starts[i] },
        (_, k) => origin.starts[block] + k,
      );
    });
  };
  const tagged = (side: Side, origin: Side, tags: readonly (string | undefined)[]): Side => {
    if (tags.length !== origin.toks.length)
      throw new Error("Rebase identity tags must match token count");
    const indices = permutation(side, origin);
    return {
      ...side,
      toks: side.toks.map((tok, i) => {
        const tag = tags[indices[i]];
        return tag === undefined
          ? tok
          : { ...tok, key: `${tok.key}\u0000${tag}`, alignmentTag: `\u0000${tag}` };
      }),
    };
  };
  const alignAll = (
    baseBlocks: readonly PMNode[],
    liveBlocks: readonly PMNode[],
    draftBlocks: readonly PMNode[],
  ) => {
    const baseSide = buildSide(baseBlocks);
    const liveSide = buildSide(liveBlocks);
    const draftSide = buildSide(draftBlocks);
    return {
      base: baseSide,
      live: liveSide,
      draft: draftSide,
      liveAlignment: align(baseSide, liveSide),
      draftAlignment: options.identity
        ? align(
            tagged(baseSide, original[BASE], options.identity.base),
            tagged(draftSide, original[DRAFT], options.identity.draft),
            true,
          )
        : align(baseSide, draftSide),
    };
  };
  let sides = alignAll(base, live, draft);
  let baseIds = base.map((_, i) => i); // original base block index of each (reordered) base block

  const order = mergeOrder(sides);
  if (order.reordered) {
    baseIds = order.baseOrder;
    sides = alignAll(
      baseIds.map((i) => base[i]),
      order.live,
      order.draft,
    );
  }

  const { base: baseSide, live: liveSide, draft: draftSide, liveAlignment, draftAlignment } = sides;
  // Identity belongs to alignment only; all merge comparisons and emitted payload use plain tokens.
  for (const h of draftAlignment.hunks)
    h.ins = draftSide.toks.slice(h.sfrom, h.sfrom + h.ins.length);
  const baseToks = baseSide.toks;
  const idsIn = (lo: number, hi: number) => {
    const ids = new Set<number>();
    for (let i = lo; i < hi; i++) ids.add(baseIds[baseSide.blockOf[i]]);
    return [...ids];
  };
  const toks = (v: MergedTok[]) => v.map((o) => o.tok);

  const conflicts: Conflict[] = order.contested.map((i) => ({
    kind: "move" as const,
    baseIds: [i],
    base: tokenizeBlock(base[i]),
    live: [],
    draft: [],
  }));
  // Live's paste of text the draft changed is left out; the draft's paste of text live changed stays
  // (the draft wins) but is reported, since it carries the text from before live's change.
  const movedByLive = dropMovedText(baseToks, liveAlignment.hunks, draftAlignment.hunks);
  const movedByDraft = dropMovedText(baseToks, draftAlignment.hunks, liveAlignment.hunks, true);
  const sourceIds = (source: number[]) => [
    ...new Set(source.map((i) => baseIds[baseSide.blockOf[i]])),
  ];
  for (const m of movedByLive)
    conflicts.push({
      kind: "moved-text",
      baseIds: sourceIds(m.source),
      base: m.source.map((i) => baseToks[i]),
      live: m.dropped,
      draft: [],
    });
  for (const m of movedByDraft)
    conflicts.push({
      kind: "moved-text",
      baseIds: sourceIds(m.source),
      base: m.source.map((i) => baseToks[i]),
      live: [],
      draft: m.dropped,
    });

  if (reslide(baseToks, liveSide.toks, liveAlignment.hunks, draftAlignment.hunks))
    liveAlignment.pos = posMap(baseToks.length, liveAlignment.hunks);
  if (reslide(baseToks, draftSide.toks, draftAlignment.hunks, liveAlignment.hunks))
    draftAlignment.pos = posMap(baseToks.length, draftAlignment.hunks);
  peel(liveAlignment.hunks, draftAlignment.hunks);

  const clusters = clusterHunks(liveAlignment.hunks, draftAlignment.hunks, baseToks);
  const merged: MergedTok[] = [];
  const copyBase = (from: number, to: number) => {
    for (let i = from; i < to; i++) merged.push({ tok: baseToks[i], origin: BASE, index: i });
  };
  let at = 0;
  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];
    const next = clusters[ci + 1];
    const coalesced = next ? coalesce(cluster, next, baseToks) : null;
    if (next && coalesced) {
      copyBase(at, cluster.lo);
      merged.push(...coalesced);
      at = next.hi;
      ci++;
      continue;
    }
    const { lo, hi, live: liveHunks, draft: draftHunks } = cluster;
    copyBase(at, lo);
    at = Math.max(at, hi);
    const liveVersion = applyWithin(baseToks, lo, hi, liveHunks, LIVE);
    if (!draftHunks.length) {
      merged.push(...liveVersion);
      continue;
    }
    const draftVersion = applyWithin(baseToks, lo, hi, draftHunks, DRAFT);
    const markMerged = mergeMarks(baseToks, liveHunks, draftHunks);
    if (markMerged) {
      merged.push(markMerged);
      continue;
    }
    if (!liveHunks.length || sameTokens(liveVersion, draftVersion)) {
      merged.push(...draftVersion);
      continue;
    }
    if (lo === hi) {
      const union = unionInsertions(liveVersion, draftVersion);
      if (union.chose)
        conflicts.push({
          kind: "overlap",
          baseIds: idsIn(Math.max(0, lo - 1), lo),
          base: [],
          live: toks(liveVersion),
          draft: toks(draftVersion),
        });
      merged.push(...union.out);
      continue;
    }
    // One side's text may already carry the other's change here (the same edit made on both sides
    // and then extended): no conflict.
    const absorbed = draftAbsorbsLive(liveVersion, draftVersion, liveHunks, baseToks);
    if (absorbed) merged.push(...absorbed);
    else {
      conflicts.push({
        kind: "overlap",
        baseIds: idsIn(lo, hi),
        base: baseToks.slice(lo, hi),
        live: toks(liveVersion),
        draft: toks(draftVersion),
      });
      merged.push(...draftVersion);
    }
  }
  copyBase(at, baseToks.length);

  const settled = settleWhitespace(
    merged,
    { base: baseToks, live: liveSide.toks, draft: draftSide.toks },
    liveAlignment.pos,
    draftAlignment.pos,
  );
  const indices = [baseSide, liveSide, draftSide].map((side, i) => permutation(side, original[i]));
  const baseToLive = new Int32Array(original[BASE].toks.length).fill(-1);
  liveAlignment.pos.forEach((at, i) => {
    if (at >= 0) baseToLive[indices[BASE][i]] = indices[LIVE][at];
  });
  return {
    blocks: buildBlocks(schema, settled).blocks,
    merged: merged.map((token, i) => ({
      ...token,
      tok: settled[i],
      index: indices[token.origin][token.index],
    })),
    baseToLive,
    conflicts,
    orderConflict: order.cyclic,
  };
}
