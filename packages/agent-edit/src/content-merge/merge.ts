import { hasBlockId, withoutBlockIds } from "@meridian/prosemirror-schema";
import { Mark, type Node as PMNode, type Schema } from "prosemirror-model";
import { align } from "../diff/align.js";
import { type Correspondence, correspond, emptyCorrespondence } from "../diff/correspond.js";
import type { Hunk } from "../diff/hunks.js";
import {
  blockKey,
  buildBlocks,
  buildSide,
  isWordTok,
  shareBlockTokens,
  type Tok,
  tokenizeBlock,
} from "../diff/tokens.js";
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
  peel,
  sameTokens,
  touch,
} from "./merge-hunks.js";
import { mergeOrder } from "./merge-order.js";
import { isOneTextTwice, settleWhitespace, unionInsertions } from "./merge-settle.js";
import { addCounts, type Fire, type RuleCounts, ruleCounter } from "./rules.js";
import { settleStretches } from "./stretch.js";

export interface Conflict {
  kind: "overlap" | "moved-text" | "move" | "attributes";
  baseIds: number[];
  base: Tok[];
  live: Tok[];
  draft: Tok[];
}

export interface ContentMergeResult {
  overrode: number;
  rules: RuleCounts;

  blocks: PMNode[];
  conflicts: Conflict[];
  orderConflict: boolean;
}

const COALESCE_WINDOW = 3;

interface Cluster {
  lo: number;
  hi: number;
  live: Hunk[];
  draft: Hunk[];
}

function clusterHunks(
  liveHunks: Hunk[],
  draftHunks: Hunk[],
  baseToks: Tok[],
  fire: Fire,
): Cluster[] {
  const all = [
    ...liveHunks.map((hunk) => ({ hunk, isLive: true })),
    ...draftHunks.map((hunk) => ({ hunk, isLive: false })),
  ].sort((x, y) => x.hunk.from - y.hunk.from || x.hunk.to - y.hunk.to || (x.isLive ? -1 : 1));
  const clusters: Cluster[] = [];
  for (const { hunk, isLive } of all) {
    const current = clusters.at(-1);
    const otherSide = current && (isLive ? current.draft : current.live);
    const touches = otherSide?.map((h) => touch(h, hunk, baseToks)).find((t) => t !== null);
    if (current && touches) {
      if (touches !== "overlap") fire(touches);
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
  rules: RuleCounts;
  merged: MergedTok[];
  overrode: number;
  conflicts: Conflict[];
  orderConflict: boolean;
}

function mergeContainers(
  schema: Schema,
  base: Tok[],
  live: MergedTok[],
  draft: MergedTok[],
  baseIds: number[],
): ContainerMerge | null {
  // Counted apart: a run that turns out not to merge pairwise must leave no counts behind.
  const { counts, fire } = ruleCounter();
  if (live.length !== base.length || draft.length !== base.length) return null;
  const out: ContainerMerge = {
    merged: [],
    overrode: 0,
    conflicts: [],
    orderConflict: false,
    rules: counts,
  };
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
    const inner = merge(schema, kids(bn), kids(ln), kids(dn), fire);
    const changed = (n: PMNode, key: string) =>
      JSON.stringify(n.attrs[key]) !== JSON.stringify(bn.attrs[key]);
    const attrs = Object.fromEntries(
      Object.keys(dn.attrs).map((key) => [key, changed(dn, key) ? dn.attrs[key] : ln.attrs[key]]),
    );
    const marks = Mark.sameSet(dn.marks, bn.marks) ? ln.marks : dn.marks;
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
    fire("containers-merged");
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

function staysFor(base: readonly PMNode[], side: readonly PMNode[]): (i: number) => 0 | 1 | 2 {
  const byId = new Map<string, PMNode>();
  for (const n of side) if (n.attrs.id != null && !byId.has(n.attrs.id)) byId.set(n.attrs.id, n);
  return (i) => {
    const now = byId.get(base[i].attrs.id);
    return now === undefined ? 0 : blockKey(now) === blockKey(base[i]) ? 1 : 2;
  };
}

function withIdsOf(node: PMNode, model: PMNode): PMNode {
  const kids: PMNode[] = [];
  node.forEach((child, _, i) => {
    kids.push(child.isText ? child : withIdsOf(child, model.child(i)));
  });
  const attrs = hasBlockId(node) ? { ...node.attrs, id: model.attrs.id } : node.attrs;
  return node.type.create(attrs, kids, node.marks);
}

/**
 * `same-block-added-twice`: both sides made the same block at one place (equal but for ids: the same split, or the same
 * paragraph typed twice). It is one block, and carries live's id, because live is the next review
 * base. Returns the draft with its copy given live's ids.
 */
function unifyAdded(
  live: readonly PMNode[],
  draft: readonly PMNode[],
  inLive: Correspondence,
  inDraft: Correspondence,
  fire: Fire,
): readonly PMNode[] {
  const added = (side: readonly PMNode[], c: Correspondence) => {
    const out = new Map<number, number[]>();
    let after = -1;
    side.forEach((_, j) => {
      const i = c.back[j];
      if (i >= 0 && !c.moved.has(i)) after = i;
      else if (i < 0) out.set(after, [...(out.get(after) ?? []), j]);
    });
    return out;
  };
  const [inL, inD] = [added(live, inLive), added(draft, inDraft)];
  let out: PMNode[] | null = null;
  for (const [after, ds] of inD) {
    const taken = new Set<number>();
    for (const d of ds) {
      const plain = blockKey(withoutBlockIds(draft[d]));
      const l = inL
        .get(after)
        ?.find((k) => !taken.has(k) && blockKey(withoutBlockIds(live[k])) === plain);
      if (l === undefined) continue;
      taken.add(l);
      out ??= [...draft];
      out[d] = withIdsOf(draft[d], live[l]);
      fire("same-block-added-twice");
    }
  }
  return out ?? draft;
}

function mergeAttributes(
  base: readonly PMNode[],
  live: readonly PMNode[],
  draft: readonly PMNode[],
  inLive: Correspondence,
  inDraft: Correspondence,
  fire: Fire,
): { sides: [PMNode[], PMNode[], PMNode[]]; clashes: Conflict[] } {
  const sides: [PMNode[], PMNode[], PMNode[]] = [[...base], [...live], [...draft]];
  const clashes: Conflict[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  base.forEach((b, i) => {
    const [l, d] = [live[inLive.partner[i]], draft[inDraft.partner[i]]];
    if (!l || !d || l.type !== b.type || d.type !== b.type) return;
    const attrs: Record<string, unknown> = {};
    let clash = false;
    for (const key of Object.keys(b.attrs)) {
      if (key === "id") continue;
      const [was, byLive, byDraft] = [b.attrs[key], l.attrs[key], d.attrs[key]];
      const liveChanged = !same(was, byLive);
      const draftChanged = !same(was, byDraft);
      clash ||= liveChanged && draftChanged && !same(byLive, byDraft);
      attrs[key] = draftChanged ? byDraft : byLive;
    }
    const at = [i, inLive.partner[i], inDraft.partner[i]];
    let changed = false;
    [b, l, d].forEach((node, k) => {
      const merged = { ...node.attrs, ...attrs };
      if (!same(merged, node.attrs)) {
        sides[k][at[k]] = node.type.create(merged, node.content, node.marks);
        changed = true;
      }
    });
    if (changed) fire("block-attributes-merged");
    if (clash)
      clashes.push({
        kind: "attributes",
        baseIds: [i],
        base: tokenizeBlock(b).slice(0, 1),
        live: tokenizeBlock(l).slice(0, 1),
        draft: tokenizeBlock(d).slice(0, 1),
      });
  });
  return { sides, clashes };
}

export function contentMerge(
  schema: Schema,
  base: readonly PMNode[],
  live: readonly PMNode[],
  draft: readonly PMNode[],
): ContentMergeResult {
  const { counts, fire } = ruleCounter();
  return { ...merge(schema, base, live, draft, fire), rules: counts };
}

function merge(
  schema: Schema,
  base: readonly PMNode[],
  live: readonly PMNode[],
  draft: readonly PMNode[],
  fire: Fire,
): Omit<ContentMergeResult, "rules"> {
  shareBlockTokens([base, live, draft]);
  let inLive = correspond(base, live, { byId: true, stays: staysFor(base, draft) });
  let inDraft = correspond(base, draft, { byId: true, stays: staysFor(base, live) });
  draft = unifyAdded(live, draft, inLive, inDraft, fire);
  const stretches = settleStretches(base, live, draft, inLive, inDraft);
  if (stretches) {
    fire("draft-wins-stretch", stretches.stretches.length);
    live = stretches.live;
    inLive = stretches.inLive;
  }
  const attributes = mergeAttributes(base, live, draft, inLive, inDraft, fire);
  [base, live, draft] = attributes.sides;
  let sides = { base: buildSide(base), live: buildSide(live), draft: buildSide(draft) };
  let baseIds = base.map((_, i) => i);

  const order = mergeOrder({ ...sides, inLive, inDraft });
  fire("draft-wins-order", order.contested.length + (order.cyclic ? 1 : 0));
  if (order.reordered) {
    fire("moved-paragraph-keeps-edits");
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
  const conflicts: Conflict[] = [
    ...attributes.clashes,
    ...order.contested.map((i) => ({
      kind: "move" as const,
      baseIds: [i],
      base: tokenizeBlock(base[i]),
      live: [],
      draft: [],
    })),
  ];
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
  const movedByLive = dropMovedText(baseToks, liveAlignment.hunks, draftAlignment.hunks);
  const movedByDraft = dropMovedText(baseToks, draftAlignment.hunks, liveAlignment.hunks, true);
  const sourceIds = (source: number[]) => [
    ...new Set(source.map((i) => baseIds[baseSide.blockOf[i]])),
  ];
  fire("moved-text-dropped", movedByLive.length);
  for (const m of movedByLive) {
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

  fire("shared-edge-kept-once", peel(liveAlignment.hunks, draftAlignment.hunks));

  const clusters = clusterHunks(liveAlignment.hunks, draftAlignment.hunks, baseToks, fire);
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
      fire("neighbouring-changes-joined");
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
      fire("marks-merged");
      merged.push(markMerged);
      continue;
    }
    if (!liveHunks.length || sameTokens(liveVersion, draftVersion)) {
      merged.push(...draftVersion);
      continue;
    }
    const nested =
      lo === hi
        ? null
        : mergeContainers(schema, baseToks.slice(lo, hi), liveVersion, draftVersion, idsIn(lo, hi));
    if (nested) {
      addCounts(fire, nested.rules);
      merged.push(...nested.merged);
      overrode += nested.overrode;
      conflicts.push(...nested.conflicts);
      orderConflict ||= nested.orderConflict;
      continue;
    }
    if (lo === hi && !isOneTextTwice(liveVersion, draftVersion)) {
      merged.push(...unionInsertions(liveVersion, draftVersion, fire));
      continue;
    }
    const absorbed = draftAbsorbsLive(liveVersion, draftVersion, liveHunks, baseToks);
    if (absorbed) merged.push(...absorbed);
    else {
      const retained = [...draftVersion];
      for (let i = lo; i < hi; i++) {
        const tok = draftPastes.get(i);
        if (tok) retained.push({ tok, origin: DRAFT, index: i });
      }
      replacedWords(liveVersion, retained);
      fire(
        [...liveVersion, ...draftVersion].some((o) => o.tok.kind === "atom")
          ? "whole-block-unit"
          : "draft-wins-text",
      );
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
    fire,
  );
  const { blocks, shape } = buildBlocks(schema, settled);
  fire("mark-dropped", shape.markDropped);
  fire("inline-moved-out", shape.inlineMovedOut);
  fire("stray-inline-wrapped", shape.strayInlineWrapped);
  return { blocks, overrode, conflicts, orderConflict };
}
