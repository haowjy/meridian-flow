/**
 * Block structure settles before words merge. Where one side removed a block the other changed, or
 * both changed which blocks there are at one place, the token merge cannot be trusted to compose the
 * two (it combined, doubled or dropped words), so the draft's blocks stand and one clash is
 * counted: `draft-wins-stretch`. The token merge afterwards sees only stretches where at most one
 * side changed the structure.
 */
import type { Node as PMNode } from "prosemirror-model";
import { type Correspondence, emptyCorrespondence } from "./correspond.js";
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
  /** By side block: it is a base block moved, whose place the order merge settles. */
  moved: Uint8Array;
  /** Per slot: a base block cut apart or joined to a neighbour (a split or a join, not a move). */
  cut: Uint8Array;
  /** A gap inside one change (between the blocks of a join). */
  interior: Uint8Array;
  /** The change a node belongs to. */
  item: (node: number) => number;
}

const TEXT = 1;
const RESTRUCTURED = 2;
const REMOVED = 3;

function view(base: readonly PMNode[], side: readonly PMNode[], c: Correspondence): View {
  const S = 2 * base.length + 1;
  const image: number[][] = Array.from({ length: S }, () => []);
  const kind = new Uint8Array(S);
  const interior = new Uint8Array(S);
  const cut = new Uint8Array(S);
  const moved = new Uint8Array(side.length);
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
    } else {
      kind[slot] = RESTRUCTURED;
      if (i >= 0) moved[j] = 1;
    }
    image[slot].push(j);
  }

  for (let i = 0; i < base.length; i++) {
    const s = 2 * i + 1;
    const j = c.partner[i];
    if (c.oldPiece[i] >= 0) {
      kind[s] = RESTRUCTURED;
      cut[s] = 1;
      const [lo, hi] = [Math.min(s, 2 * c.oldPiece[i] + 1), Math.max(s, 2 * c.oldPiece[i] + 1)];
      for (let k = lo; k < hi; k++) link(k, hi);
    } else if (j < 0) kind[s] = REMOVED;
    else if (c.moved.has(i)) {
      kind[s] = RESTRUCTURED;
      for (let k = j; k < side.length && (k === j || c.nextPiece[k] === j); k++) link(S + k, s);
    } else if (image[s].length > 1 || (i + 1 < base.length && c.oldPiece[i + 1] === i)) {
      kind[s] = RESTRUCTURED;
      cut[s] = 1;
    } else if (blockKey(base[i]) !== blockKey(side[j])) kind[s] = TEXT;
  }
  // A gap between two blocks of one change is inside that change.
  for (let g = 1; g < base.length; g++)
    if (kind[2 * g - 1] && kind[2 * g + 1] && item(2 * g - 1) === item(2 * g + 1)) {
      interior[2 * g] = 1;
      kind[2 * g] = RESTRUCTURED;
      link(2 * g, 2 * g - 1);
    }
  return { image, kind, moved, cut, interior, item };
}

/** A side's block (second) and the slot it sits in (first; -1 for a moved base block, placed by the order merge). */
type Placed = [slot: number, block: number];

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
 * - at a base block, when one side removed the block and the other changed it in any way, or both
 *   sides restructured it, or one side split or joined a container (a table row, a quote) that the
 *   other changed: the token merge sees a container as one token, so an edit cannot travel into its
 *   pieces as it does into a paragraph's;
 * - at a gap inside a join, when the other side has anything there.
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
        (L.kind[s] >= RESTRUCTURED && D.kind[s] >= RESTRUCTURED) ||
        ((L.cut[s] || D.cut[s]) && !base[(s - 1) / 2].isTextblock) ||
        L.kind[s] === REMOVED ||
        D.kind[s] === REMOVED
      )
        hit(l, d);
      continue;
    }
    for (const l of members(L, s))
      for (const d of members(D, s)) if (L.interior[s] || D.interior[s]) hit(l, d);
  }
  for (let x = 0; x < clash.length; x++) if (clash[x]) clash[find(x)] = 1;
  const clashOf = (v: View, node: number, shift: number) => {
    const r = find(shift + v.item(node));
    return clash[r] ? r : -1;
  };

  // Per clash: the base blocks it covers and each side's blocks there.
  const parts = new Map<number, { slots: number[]; l: Placed[]; d: Placed[] }>();
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
      p.l.push(...L.image[s].map((j): Placed => [L.moved[j] ? -1 : s, j]));
      p.d.push(...D.image[s].map((j): Placed => [D.moved[j] ? -1 : s, j]));
    } else {
      for (const j of L.image[s])
        if (clashOf(L, S + j, 0) >= 0) part(clashOf(L, S + j, 0)).l.push([L.moved[j] ? -1 : s, j]);
      for (const j of D.image[s])
        if (clashOf(D, S + j, off) >= 0)
          part(clashOf(D, S + j, off)).d.push([D.moved[j] ? -1 : s, j]);
    }
  }
  const taken = new Uint8Array(S);
  const dropped = new Uint8Array(live.length);
  const stretches: Stretch[] = [];
  for (const p of parts.values()) {
    // The same blocks in the same places on both sides is no clash.
    if (
      p.l.length === p.d.length &&
      p.l.every(([s, j], x) => s === p.d[x][0] && blockKey(live[j]) === blockKey(draft[p.d[x][1]]))
    )
      continue;
    for (const s of p.slots) taken[s] = 1;
    for (const [, j] of p.l) dropped[j] = 1;
    stretches.push({
      baseIds: p.slots.map((s) => (s - 1) / 2),
      live: p.l.map(([, j]) => live[j]),
      draft: p.d.map(([, j]) => draft[j]),
    });
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
