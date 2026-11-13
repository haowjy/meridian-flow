/**
 * The content rebase: a pure three-way merge of base, live and draft top-level blocks. It brings live's
 * newer edits into a Work draft (and, with the patch as the draft side, writes an Apply into live).
 *
 * Nothing relates the sides' Yjs items; the tokens of each side are aligned to base, paragraph moves are
 * lifted so the other side's edits travel with the paragraph (`merge-order.ts`), and the two hunk lists
 * are merged (`merge-hunks.ts`, `merge-settle.ts`). Hunks from one side apply. Overlapping hunks with
 * equal results apply once. Insertions at one point keep both (live first). Anything else is a
 * conflict: the draft's version stays, so the conflict shows in review as diff(new base = live, draft).
 * It works on `align`'s uncleaned hunks for word precision. No Yjs here: the minimal Yjs writer is
 * `writer.ts`.
 */
import { Mark, type Node as PMNode, type Schema } from "prosemirror-model";
import { align } from "./align.js";
import { type Correspondence, correspond, emptyCorrespondence } from "./correspond.js";
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
import { settleStretches } from "./stretch.js";
import {
  blockKey,
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

export interface RebaseResult {
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
  if (inserts && isSubsequence(liveVersion, draftVersion)) return draftVersion;
  if (inserts && isSubsequence(draftVersion, liveVersion)) return liveVersion;
  return draftAbsorbsLive(liveVersion, draftVersion, liveHunks, baseToks);
}

/** Whether a table's cells, with their `colspan` and `rowspan`, fill a rectangle with no overlap or hole. */
function isRectangular(table: PMNode): boolean {
  const taken = new Set<string>();
  let width = 0;
  for (let r = 0; r < table.childCount; r++) {
    let c = 0;
    table.child(r).forEach((cell) => {
      while (taken.has(`${r},${c}`)) c++;
      const [cs, rs] = [Number(cell.attrs.colspan ?? 1), Number(cell.attrs.rowspan ?? 1)];
      for (let dr = 0; dr < rs; dr++)
        for (let dc = 0; dc < cs; dc++) {
          const at = `${r + dr},${c + dc}`;
          if (taken.has(at)) width = Number.POSITIVE_INFINITY;
          taken.add(at);
        }
      c += cs;
      if (Number.isFinite(width)) width = Math.max(width, c);
    });
  }
  if (!Number.isFinite(width)) return false;
  for (const at of taken) if (Number(at.split(",")[0]) >= table.childCount) return false;
  return taken.size === width * table.childCount;
}

interface ContainerMerge {
  merged: MergedTok[];
  overrode: number;
  conflicts: Conflict[];
  orderConflict: boolean;
}

/**
 * Both sides changed a run of containers (lists, quotes, tables) that each side kept as the same
 * number of the same types, so the run merges pairwise by the containers' children instead of
 * as whole-block tokens. Null when the run does not have that shape, or when a merged node would
 * not be a valid container: the caller then keeps the `whole-block-unit` clash.
 */
function mergeContainers(
  schema: Schema,
  base: Tok[],
  live: MergedTok[],
  draft: MergedTok[],
  baseIds: number[],
): ContainerMerge | null {
  if (live.length !== base.length || draft.length !== base.length) return null;
  const out: ContainerMerge = { merged: [], overrode: 0, conflicts: [], orderConflict: false };
  const kids = (n: PMNode) => {
    const nodes: PMNode[] = [];
    n.forEach((c) => {
      nodes.push(c);
    });
    return nodes;
  };
  for (let i = 0; i < base.length; i++) {
    const [b, l, d] = [base[i], live[i].tok, draft[i].tok];
    if (b.kind !== "atom" || l.kind !== "atom" || d.kind !== "atom") return null;
    const [bn, ln, dn] = [b.node, l.node, d.node];
    if (bn.type !== ln.type || bn.type !== dn.type || !bn.firstChild?.isBlock) return null;
    if (l.key === b.key || l.key === d.key) {
      out.merged.push(draft[i]);
      continue;
    }
    if (d.key === b.key) {
      out.merged.push(live[i]);
      continue;
    }
    const inner = rebase(schema, kids(bn), kids(ln), kids(dn));
    const changed = (n: PMNode, key: string) =>
      JSON.stringify(n.attrs[key]) !== JSON.stringify(bn.attrs[key]);
    const attrs = Object.fromEntries(
      Object.keys(dn.attrs).map((key) => [key, changed(dn, key) ? dn.attrs[key] : ln.attrs[key]]),
    );
    const marks = Mark.sameSet(dn.marks, bn.marks) ? ln.marks : dn.marks;
    // Both sides changed one attribute (or the marks) to different values: the draft's stands.
    if (
      Object.keys(dn.attrs).some(
        (key) =>
          changed(dn, key) &&
          changed(ln, key) &&
          JSON.stringify(ln.attrs[key]) !== JSON.stringify(dn.attrs[key]),
      ) ||
      (!Mark.sameSet(dn.marks, bn.marks) &&
        !Mark.sameSet(ln.marks, bn.marks) &&
        !Mark.sameSet(ln.marks, dn.marks))
    ) {
      out.conflicts.push({ kind: "overlap", baseIds, base: [b], live: [l], draft: [d] });
    }
    let node: PMNode;
    try {
      node = bn.type.create(attrs, inner.blocks, marks);
      node.check();
    } catch {
      return null;
    }
    if (bn.type.name === "table" && !isRectangular(node)) return null;
    out.merged.push({
      tok: { kind: "atom", key: `A${blockKey(node)}`, node },
      origin: DRAFT,
      index: draft[i].index,
    });
    out.overrode += inner.overrode;
    out.conflicts.push(...inner.conflicts.map((c) => ({ ...c, baseIds })));
    out.orderConflict ||= inner.orderConflict;
  }
  return out;
}

/** A correspondence carried onto reordered sides. Pairs that no longer run in order stay; `align` skips them. */
function relaid(c: Correspondence, baseOrder: number[], sideOrder: number[]): Correspondence {
  const baseAt = new Int32Array(c.partner.length).fill(-1);
  baseOrder.forEach((o, n) => {
    baseAt[o] = n;
  });
  const sideAt = new Int32Array(c.back.length).fill(-1);
  sideOrder.forEach((o, n) => {
    sideAt[o] = n;
  });
  const out = emptyCorrespondence(baseOrder.length, sideOrder.length);
  baseOrder.forEach((o, n) => {
    if (c.partner[o] >= 0 && sideAt[c.partner[o]] >= 0) {
      out.partner[n] = sideAt[c.partner[o]];
      out.back[out.partner[n]] = n;
    }
    if (c.oldPiece[o] >= 0) out.oldPiece[n] = baseAt[c.oldPiece[o]];
  });
  sideOrder.forEach((o, n) => {
    if (c.nextPiece[o] >= 0) out.nextPiece[n] = sideAt[c.nextPiece[o]];
  });
  return out;
}

export function rebase(
  schema: Schema,
  base: readonly PMNode[],
  live: readonly PMNode[],
  draft: readonly PMNode[],
): RebaseResult {
  shareBlockTokens([base, live, draft]);
  let inLive = correspond(base, live, { moves: true });
  let inDraft = correspond(base, draft, { moves: true });
  const stretches = settleStretches(base, live, draft, inLive, inDraft);
  if (stretches) {
    live = stretches.live;
    inLive = stretches.inLive;
  }
  let sides = { base: buildSide(base), live: buildSide(live), draft: buildSide(draft) };
  let baseIds = base.map((_, i) => i); // original base block index of each (reordered) base block

  const order = mergeOrder({ ...sides, inLive, inDraft });
  if (order.reordered) {
    baseIds = order.baseOrder;
    inLive = relaid(inLive, order.baseOrder, order.liveOrder);
    inDraft = relaid(inDraft, order.baseOrder, order.draftOrder);
    sides = {
      base: buildSide(baseIds.map((i) => base[i])),
      live: buildSide(order.live),
      draft: buildSide(order.draft),
    };
  }
  const { base: baseSide, live: liveSide, draft: draftSide } = sides;
  const liveAlignment = align(baseSide, liveSide, inLive);
  const draftAlignment = align(baseSide, draftSide, inDraft);
  // Each removed block is its own removal, so one side's removal of a run meets the other's block by block.
  for (const a of [liveAlignment, draftAlignment])
    a.hunks = a.hunks.flatMap((h) => {
      if (h.ins.length) return [h];
      const cuts = [h.from];
      for (
        let b = baseSide.blockOf[h.from] + 1;
        b < baseSide.starts.length && baseSide.starts[b] < h.to;
        b++
      )
        if (baseSide.starts[b] > h.from) cuts.push(baseSide.starts[b]);
      cuts.push(h.to);
      return cuts.slice(1).map((to, k) => ({ ...h, from: cuts[k], to }));
    });
  const baseToks = baseSide.toks;
  const idsIn = (lo: number, hi: number) => {
    const ids = new Set<number>();
    for (let i = lo; i < hi; i++) ids.add(baseIds[baseSide.blockOf[i]]);
    return [...ids];
  };
  const toks = (v: MergedTok[]) => v.map((o) => o.tok);

  let overrode = 0;
  let orderConflict = order.cyclic;
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
  // A stretch where the pairing could not be trusted keeps the draft's blocks: one clash each.
  for (const st of stretches?.stretches ?? []) {
    const [l, d] = [st.live, st.draft].map((bs) => bs.flatMap((b) => tokenizeBlock(b)));
    replacedWords(
      l.map((tok) => ({ tok, origin: LIVE, index: 0 })),
      d.map((tok) => ({ tok, origin: DRAFT, index: 0 })),
    );
    conflicts.push({
      kind: "overlap",
      baseIds: st.baseIds,
      base: st.baseIds.flatMap((i) => tokenizeBlock(base[i])),
      live: l,
      draft: d,
    });
  }
  // Live's paste of text the draft changed is left out; the draft's paste of text live changed stays
  // (the draft wins) but is reported, since it carries the text from before live's change.
  const movedByLive = dropMovedText(baseToks, liveAlignment.hunks, draftAlignment.hunks);
  const movedByDraft = dropMovedText(baseToks, draftAlignment.hunks, liveAlignment.hunks, true);
  const sourceIds = (source: number[]) => [
    ...new Set(source.map((i) => baseIds[baseSide.blockOf[i]])),
  ];
  for (const m of movedByLive) {
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
      merged.push(...draftVersion);
      continue;
    }
    // An unpaired replacement says the blocks are not each other: nothing to merge by index inside.
    const nested =
      lo === hi || [...liveHunks, ...draftHunks].some((h) => h.unpaired)
        ? null
        : mergeContainers(schema, baseToks.slice(lo, hi), liveVersion, draftVersion, idsIn(lo, hi));
    if (nested) {
      merged.push(...nested.merged);
      overrode += nested.overrode;
      conflicts.push(...nested.conflicts);
      orderConflict ||= nested.orderConflict;
      continue;
    }
    if (lo === hi) {
      merged.push(...unionInsertions(liveVersion, draftVersion));
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
  const { blocks } = buildBlocks(schema, settled);
  return { blocks, overrode, conflicts, orderConflict };
}
