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
import { settleWhitespace, subsequenceSources, unionInsertions } from "./merge-settle.js";
import {
  buildBlocks,
  buildSide,
  isWordTok,
  shareBlockTokens,
  type Tok,
  tokenizeBlock,
} from "./tokens.js";

export interface Conflict {
  kind: "overlap" | "moved-text" | "move";
  baseIds: number[]; // original base block indices the conflict covers
  base: Tok[];
  live: Tok[];
  draft: Tok[];
}

export interface BlockSource {
  side: "base" | "live" | "draft";
  index: number;
}

export interface BlockCorrespondence {
  /** Null denotes input blocks removed from the result. */
  output: number | null;
  sources: BlockSource[];
}

export interface RebaseResult {
  correspondence: BlockCorrespondence[];
  overrode: number; // live words replaced by the draft in contested text

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
  if (inserts && isSubsequence(liveVersion, draftVersion))
    return subsequenceSources(draftVersion, liveVersion);
  if (inserts && isSubsequence(draftVersion, liveVersion))
    return subsequenceSources(liveVersion, draftVersion);
  return draftAbsorbsLive(liveVersion, draftVersion, liveHunks, baseToks);
}

export function rebase(
  schema: Schema,
  base: readonly PMNode[],
  live: readonly PMNode[],
  draft: readonly PMNode[],
): RebaseResult {
  shareBlockTokens([base, live, draft]);
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
      draftAlignment: align(baseSide, draftSide),
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
  const baseToks = baseSide.toks;
  const idsIn = (lo: number, hi: number) => {
    const ids = new Set<number>();
    for (let i = lo; i < hi; i++) ids.add(baseIds[baseSide.blockOf[i]]);
    return [...ids];
  };
  const toks = (v: MergedTok[]) => v.map((o) => o.tok);

  let overrode = 0;
  const replacedWords = (live: MergedTok[], kept: MergedTok[]) => {
    const remaining = new Map<string, number>();
    for (const { tok } of kept)
      if (isWordTok(tok)) remaining.set(tok.key, (remaining.get(tok.key) ?? 0) + 1);
    for (const { tok } of live)
      if (isWordTok(tok)) {
        const n = remaining.get(tok.key) ?? 0;
        if (n) remaining.set(tok.key, n - 1);
        else overrode++;
      }
  };
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
  const removedLiveSources = new Map<number, Set<number>>();
  for (const m of movedByLive) {
    const baseBlocks = sourceIds(m.source);
    for (const token of m.destination) {
      const j = liveSide.blockOf[token];
      const original = order.reordered ? order.liveOrder[j] : j;
      const sources = removedLiveSources.get(original) ?? new Set<number>();
      for (const index of baseBlocks) sources.add(index);
      removedLiveSources.set(original, sources);
    }
    // The stale paste vanished, but words kept at the edited source were not replaced.
    overrode += m.source.filter((i) => isWordTok(baseToks[i]) && draftAlignment.pos[i] < 0).length;
    conflicts.push({
      kind: "moved-text",
      baseIds: sourceIds(m.source),
      base: m.source.map((i) => baseToks[i]),
      live: m.dropped,
      draft: [],
    });
  }
  const draftPastes = new Map<number, Tok>();
  for (const m of movedByDraft) {
    m.source.forEach((source, i) => {
      draftPastes.set(source, m.dropped[i]);
    });
    conflicts.push({
      kind: "moved-text",
      baseIds: sourceIds(m.source),
      base: m.source.map((i) => baseToks[i]),
      live: [],
      draft: m.dropped,
    });
  }

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
      merged.push(
        ...(liveHunks.length ? subsequenceSources(draftVersion, liveVersion) : draftVersion),
      );
      continue;
    }
    if (lo === hi) {
      const union = unionInsertions(liveVersion, draftVersion);
      if (union.chose) {
        replacedWords(liveVersion, union.out);
        conflicts.push({
          kind: "overlap",
          baseIds: idsIn(Math.max(0, lo - 1), lo),
          base: [],
          live: toks(liveVersion),
          draft: toks(draftVersion),
        });
      }
      merged.push(...union.out);
      continue;
    }
    // One side's text may already carry the other's change here (the same edit made on both sides
    // and then extended): no conflict.
    const absorbed = draftAbsorbsLive(liveVersion, draftVersion, liveHunks, baseToks);
    if (absorbed) merged.push(...absorbed);
    else {
      // Words cut by the draft may still survive at its paste destination.
      const retained = [...draftVersion];
      for (let i = lo; i < hi; i++) {
        const tok = draftPastes.get(i);
        if (tok) retained.push({ tok, origin: DRAFT, index: i });
      }
      replacedWords(liveVersion, retained);
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
  const correspondence: BlockCorrespondence[] = [];
  const represented = new Set<string>();
  const liveBase = new Map<number, number>();
  const draftBase = new Map<number, number>();
  order.inLive.forEach((j, i) => {
    if (j >= 0) liveBase.set(j, i);
  });
  order.inDraft.forEach((j, i) => {
    if (j >= 0) draftBase.set(j, i);
  });
  const blocks = buildBlocks(schema, settled, {
    onBlock(output, tokens) {
      const sources = new Map<string, BlockSource>();
      const add = (side: BlockSource["side"], index: number) => {
        if (index < 0) return;
        const key = `${side}:${index}`;
        sources.set(key, { side, index });
        represented.add(key);
      };
      for (const token of tokens) {
        const current = merged[token];
        for (const origin of [current, ...(current.sources ?? [])]) {
          let b = -1;
          if (origin.origin === BASE) {
            b = baseIds[baseSide.blockOf[origin.index]];
            const l = liveAlignment.pos[origin.index];
            const d = draftAlignment.pos[origin.index];
            if (l >= 0) {
              const j = liveSide.blockOf[l];
              add("live", order.reordered ? order.liveOrder[j] : j);
            }
            if (d >= 0) {
              const j = draftSide.blockOf[d];
              add("draft", order.reordered ? order.draftOrder[j] : j);
            }
          } else if (origin.origin === LIVE) {
            const j = liveSide.blockOf[origin.index];
            const original = order.reordered ? order.liveOrder[j] : j;
            add("live", original);
            b = liveBase.get(original) ?? -1;
          } else {
            const j = draftSide.blockOf[origin.index];
            const original = order.reordered ? order.draftOrder[j] : j;
            add("draft", original);
            b = draftBase.get(original) ?? -1;
          }
          if (b >= 0) {
            add("base", b);
            add("live", order.inLive[b]);
            add("draft", order.inDraft[b]);
          }
        }
      }
      for (const source of [...sources.values()])
        if (source.side === "live")
          for (const index of removedLiveSources.get(source.index) ?? []) {
            add("base", index);
            add("draft", order.inDraft[index]);
          }
      correspondence.push({ output, sources: [...sources.values()] });
    },
  }).blocks;
  base.forEach((_, index) => {
    if (represented.has(`base:${index}`)) return;
    const sources: BlockSource[] = [{ side: "base", index }];
    for (const [side, partner] of [
      ["live", order.inLive],
      ["draft", order.inDraft],
    ] as const) {
      const j = partner[index];
      if (j >= 0 && !represented.has(`${side}:${j}`)) {
        sources.push({ side, index: j });
        represented.add(`${side}:${j}`);
      }
    }
    represented.add(`base:${index}`);
    for (const source of [...sources])
      if (source.side === "live")
        for (const index of removedLiveSources.get(source.index) ?? []) {
          sources.push({ side: "base", index });
          if (order.inDraft[index] >= 0)
            sources.push({ side: "draft", index: order.inDraft[index] });
        }
    correspondence.push({ output: null, sources });
  });
  for (const [side, input] of [
    ["base", base],
    ["live", live],
    ["draft", draft],
  ] as const)
    input.forEach((_, index) => {
      if (!represented.has(`${side}:${index}`)) {
        const sources: BlockSource[] = [{ side, index }];
        const baseIndex =
          side === "live"
            ? liveBase.get(index)
            : side === "draft"
              ? draftBase.get(index)
              : undefined;
        if (baseIndex !== undefined) {
          sources.push({ side: "base", index: baseIndex });
          if (side !== "live" && order.inLive[baseIndex] >= 0)
            sources.push({ side: "live", index: order.inLive[baseIndex] });
          if (side !== "draft" && order.inDraft[baseIndex] >= 0)
            sources.push({ side: "draft", index: order.inDraft[baseIndex] });
        }
        if (side === "live")
          for (const base of removedLiveSources.get(index) ?? []) {
            sources.push({ side: "base", index: base });
            if (order.inDraft[base] >= 0)
              sources.push({ side: "draft", index: order.inDraft[base] });
          }
        correspondence.push({ output: null, sources });
      }
    });
  return { blocks, correspondence, overrode, conflicts, orderConflict: order.cyclic };
}
