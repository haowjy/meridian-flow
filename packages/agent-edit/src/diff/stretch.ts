/**
 * Block structure settles before words merge. Where both sides changed one stretch of the base and
 * either nothing says which block is which, or both changed which blocks there are, the token merge
 * cannot be trusted to compose the two (it combined, doubled or dropped words), so the draft's
 * blocks stand and one clash is counted: `draft-wins-stretch`. The token merge afterwards sees only
 * stretches where at most one side changed the structure.
 */
import type { Node as PMNode } from "prosemirror-model";
import { type Correspondence, couldBeSameAddition, emptyCorrespondence } from "./correspond.js";
import { Dsu } from "./dsu.js";
import { blockKey } from "./tokens.js";

/**
 * One side's changes laid over the base. Slot 2g is the gap before base block g, slot 2i+1 is base
 * block i. A change is a set of nodes: slots, and the side's blocks that sit in a gap (node S+j for
 * side block j), joined where one decision covers them.
 */
interface View {
  /** The side's blocks that sit in each slot. */
  image: number[][];
  /** Per slot: 0 unchanged, 1 text changed, 2 split, joined, moved or added, 3 removed. */
  kind: Uint8Array;
  /** A gap inside one change (between the blocks of a join, or of an unsure group). */
  interior: Uint8Array;
  /** The change a node belongs to. */
  item: (node: number) => number;
  /** By change: its pairing is unsure. */
  unsure: Uint8Array;
  /** By change: it holds a base block, so it is more than blocks added in a gap. */
  solid: Uint8Array;
}

const TEXT = 1;
const RESTRUCTURED = 2;
const REMOVED = 3;

function view(base: readonly PMNode[], side: readonly PMNode[], c: Correspondence): View {
  const S = 2 * base.length + 1;
  const image: number[][] = Array.from({ length: S }, () => []);
  const kind = new Uint8Array(S);
  const interior = new Uint8Array(S);
  const changes = new Dsu(S + side.length);
  const item = (x: number) => changes.find(x);
  const link = (a: number, b: number) => changes.union(a, b);
  const inPlace = (i: number) => c.partner[i] >= 0 && !c.moved.has(i);

  // Every block of the side sits in a base block's place (its pair in order, with its pieces) or in a gap.
  let gap = 0;
  for (let j = 0; j < side.length; j++) {
    const first = c.nextPiece[j] >= 0 ? c.nextPiece[j] : j;
    const i = c.back[first];
    let slot = 2 * gap;
    if (i >= 0 && inPlace(i)) {
      slot = 2 * i + 1;
      let end = i + 1;
      while (end < base.length && c.oldPiece[end] === i) end++;
      gap = end;
    } else kind[slot] = RESTRUCTURED;
    image[slot].push(j);
  }

  const groups = new Map<number, number>();
  const group = (g: number, node: number) => {
    const at = groups.get(g);
    if (at === undefined) groups.set(g, node);
    else link(node, at);
  };
  const unsureNode = new Uint8Array(S + side.length);
  for (let i = 0; i < base.length; i++) {
    const s = 2 * i + 1;
    const j = c.partner[i];
    if (c.oldPiece[i] >= 0) {
      kind[s] = RESTRUCTURED;
      for (let k = 2 * c.oldPiece[i] + 1; k < s; k++) link(k, s);
    } else if (j < 0) kind[s] = REMOVED;
    else if (c.moved.has(i)) {
      kind[s] = RESTRUCTURED;
      for (let k = j; k < side.length && (k === j || c.nextPiece[k] === j); k++) link(S + k, s);
    } else if (image[s].length > 1 || (i + 1 < base.length && c.oldPiece[i + 1] === i))
      kind[s] = RESTRUCTURED;
    else if (blockKey(base[i]) !== blockKey(side[j])) kind[s] = TEXT;
    if (c.unsureOld[i] >= 0) {
      unsureNode[s] = 1;
      if (!kind[s]) kind[s] = TEXT;
      group(c.unsureOld[i], s);
    }
  }
  for (let j = 0; j < side.length; j++)
    if (c.unsureNext[j] >= 0) {
      unsureNode[S + j] = 1;
      group(c.unsureNext[j], S + j);
    }
  // A gap between two blocks of one change is inside that change.
  for (let g = 1; g < base.length; g++)
    if (kind[2 * g - 1] && kind[2 * g + 1] && item(2 * g - 1) === item(2 * g + 1)) {
      interior[2 * g] = 1;
      kind[2 * g] = RESTRUCTURED;
      link(2 * g, 2 * g - 1);
    }
  const unsure = new Uint8Array(S + side.length);
  const solid = new Uint8Array(S + side.length);
  for (let x = 0; x < S + side.length; x++) {
    if (unsureNode[x]) unsure[item(x)] = 1;
    if (x < S && kind[x] && (x % 2 || interior[x])) solid[item(x)] = 1;
  }
  return { image, kind, interior, item, unsure, solid };
}

export interface Stretch {
  /** The base blocks the clash covers. */
  baseIds: number[];
  /** Live's blocks that were dropped, and the draft's that stand. */
  live: PMNode[];
  draft: PMNode[];
}

/**
 * Returns live with its changes to each clashed stretch undone (the base's blocks in place, paired
 * one to one; its added and moved-in blocks of those changes gone), so the token merge finds the
 * draft's change alone there; null when nothing clashes.
 *
 * Two changes clash when they meet at one place and the token merge cannot be trusted with them:
 * - at a base block, when either change is unsure, or one side removed the block and the other
 *   changed it in any way, or both sides restructured it;
 * - at a gap inside a join or an unsure group, when the other side has anything there;
 * - at any other gap, when one change is unsure and neither is only blocks added there.
 * Text against text, text against a split, a join or a move of that block (the edit travels with
 * it), additions by both sides at one gap (both kept) and removals of different blocks are left to
 * the token merge.
 */
export function settleStretches(
  base: readonly PMNode[],
  live: readonly PMNode[],
  draft: readonly PMNode[],
  inLive: Correspondence,
  inDraft: Correspondence,
): { live: PMNode[]; inLive: Correspondence; stretches: Stretch[] } | null {
  const S = 2 * base.length + 1;
  const L = view(base, live, inLive);
  const D = view(base, draft, inDraft);
  // One union-find over both sides' nodes; a clash joins a live change to a draft change.
  const off = S + live.length;
  const clashes = new Dsu(off + S + draft.length);
  const find = (x: number) => clashes.find(x);
  const clash = new Uint8Array(off + S + draft.length);
  const hit = (l: number, d: number) => {
    clashes.union(l, off + d);
    clash[find(l)] = 1;
  };
  const members = (v: View, s: number) => [
    ...(v.interior[s] ? [v.item(s)] : []),
    ...v.image[s].map((j) => v.item(S + j)),
  ];
  for (let s = 0; s < S; s++) {
    if (!L.kind[s] || !D.kind[s]) continue;
    if (s % 2) {
      const [l, d] = [L.item(s), D.item(s)];
      if (
        L.unsure[l] ||
        D.unsure[d] ||
        (L.kind[s] >= RESTRUCTURED && D.kind[s] >= RESTRUCTURED) ||
        L.kind[s] === REMOVED ||
        D.kind[s] === REMOVED
      )
        hit(l, d);
      continue;
    }
    for (const l of members(L, s))
      for (const d of members(D, s))
        if (
          L.interior[s] ||
          D.interior[s] ||
          ((L.unsure[l] || D.unsure[d]) && L.solid[l] && D.solid[d])
        )
          hit(l, d);
  }
  for (let x = 0; x < clash.length; x++) if (clash[x]) clash[find(x)] = 1;
  const clashOf = (v: View, node: number, shift: number) => {
    const r = find(shift + v.item(node));
    return clash[r] ? r : -1;
  };

  // Per clash: the base blocks it covers and each side's blocks there.
  const parts = new Map<number, { slots: number[]; l: number[]; d: number[] }>();
  const part = (r: number) => {
    let p = parts.get(r);
    if (!p) {
      p = { slots: [], l: [], d: [] };
      parts.set(r, p);
    }
    return p;
  };
  for (let s = 0; s < S; s++) {
    if (s % 2) {
      const r = Math.max(L.kind[s] ? clashOf(L, s, 0) : -1, D.kind[s] ? clashOf(D, s, off) : -1);
      if (r < 0) continue;
      const p = part(r);
      p.slots.push(s);
      p.l.push(...L.image[s]);
      p.d.push(...D.image[s]);
    } else {
      for (const j of L.image[s])
        if (clashOf(L, S + j, 0) >= 0) part(clashOf(L, S + j, 0)).l.push(j);
      for (const j of D.image[s])
        if (clashOf(D, S + j, off) >= 0) part(clashOf(D, S + j, off)).d.push(j);
    }
  }
  const taken = new Uint8Array(S);
  const dropped = new Uint8Array(live.length);
  const stretches: Stretch[] = [];
  for (const p of parts.values()) {
    // The same blocks on both sides is no clash.
    if (
      p.l.length === p.d.length &&
      p.l.every((j, x) => blockKey(live[j]) === blockKey(draft[p.d[x]]))
    )
      continue;
    for (const s of p.slots) taken[s] = 1;
    for (const j of p.l) dropped[j] = 1;
    stretches.push({
      baseIds: p.slots.map((s) => (s - 1) / 2),
      live: p.l.map((j) => live[j]),
      draft: p.d.map((j) => draft[j]),
    });
  }

  // Blocks both sides added at one gap: one that is the other's block changed, or may be, is the
  // draft's; equal blocks are kept once and unrelated ones are both kept.
  for (let s = 0; s < S; s += 2) {
    const free = (v: View, shift: number) => (j: number) =>
      !v.solid[v.item(S + j)] && clashOf(v, S + j, shift) < 0;
    const [ls, ds] = [L.image[s].filter(free(L, 0)), D.image[s].filter(free(D, off))];
    if (!ls.length || !ds.length) continue;
    const mine = ls.filter(
      (j) =>
        !ds.some((d) => blockKey(live[j]) === blockKey(draft[d])) &&
        ds.some((d) => couldBeSameAddition(live[j], draft[d])),
    );
    if (!mine.length) continue;
    for (const j of mine) dropped[j] = 1;
    stretches.push({ baseIds: [], live: mine.map((j) => live[j]), draft: ds.map((j) => draft[j]) });
  }
  if (!stretches.length) return null;

  const out: PMNode[] = [];
  const fromLive = new Int32Array(live.length).fill(-1);
  const partner = new Int32Array(base.length).fill(-1);
  for (let s = 0; s < S; s++) {
    if (taken[s]) {
      partner[(s - 1) / 2] = out.length;
      out.push(base[(s - 1) / 2]);
    } else
      for (const j of L.image[s])
        if (!dropped[j]) {
          fromLive[j] = out.length;
          out.push(live[j]);
        }
  }
  const c = emptyCorrespondence(base.length, out.length);
  c.partner.set(partner);
  for (let i = 0; i < base.length; i++) {
    if (!taken[2 * i + 1]) {
      const j = inLive.partner[i] >= 0 ? fromLive[inLive.partner[i]] : -1;
      if (j >= 0) {
        c.partner[i] = j;
        if (inLive.moved.has(i)) c.moved.add(i);
      }
      c.oldPiece[i] = inLive.oldPiece[i];
    }
    if (c.partner[i] >= 0) c.back[c.partner[i]] = i;
  }
  fromLive.forEach((m, j) => {
    if (m >= 0 && inLive.nextPiece[j] >= 0) c.nextPiece[m] = fromLive[inLive.nextPiece[j]];
  });
  return { live: out, inLive: c, stretches };
}
