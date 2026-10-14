/**
 * Which chats' AI edits overlap each review group, read from the draft's Yjs items.
 *
 * The payload (`edits`) lists, per AI edit part, the item ranges it inserted and deleted. A group
 * matches an edit when a visible item under the group's green ranges falls in `inserted`, or a
 * tombstone in the group's draft blocks (or in the gap where a whole block was removed) falls in
 * `deleted`. Yjs records no deleter, so deletions attribute at block granularity. This is a hint for
 * a chat name on a card: nothing gates on it, and writer edits are never named (W1).
 */
import * as Y from "yjs";
import type { ReviewGroup, ReviewProjection } from "./review.js";

export type ItemRange = readonly [client: number, clock: number, length: number];

export interface AttributionEdit {
  threadId: string;
  title: string;
  turnId: string;
  at: string;
  inserted: readonly ItemRange[];
  deleted: readonly ItemRange[];
}
export type ChatHint = Pick<AttributionEdit, "threadId" | "title" | "turnId" | "at">;

/** Merged, sorted id intervals per client, answering "does any id in [lo, hi) fall in the set". */
class RangeSet {
  private byClient = new Map<number, Array<[number, number]>>();
  constructor(ranges: readonly ItemRange[]) {
    for (const [client, clock, length] of ranges) {
      const list = this.byClient.get(client);
      if (list) list.push([clock, clock + length]);
      else this.byClient.set(client, [[clock, clock + length]]);
    }
    for (const list of this.byClient.values()) {
      list.sort((a, b) => a[0] - b[0]);
      let w = 0;
      for (const r of list) {
        if (w && r[0] <= list[w - 1][1]) list[w - 1][1] = Math.max(list[w - 1][1], r[1]);
        else list[w++] = r;
      }
      list.length = w;
    }
  }
  overlaps(client: number, lo: number, hi: number): boolean {
    const list = this.byClient.get(client);
    if (!list) return false;
    let a = 0;
    let b = list.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (list[m][1] <= lo) a = m + 1;
      else b = m;
    }
    return a < list.length && list[a][0] < hi;
  }
}

interface IdSpan {
  client: number;
  lo: number;
  hi: number;
}
const spanOf = (item: Y.Item, lo = 0, hi = item.length): IdSpan => ({
  client: item.id.client,
  lo: item.id.clock + lo,
  hi: item.id.clock + hi,
});

function* children(item: Y.Item): Generator<Y.Item> {
  if (!(item.content instanceof Y.ContentType)) return;
  for (let c = item.content.type._start; c; c = c.right) yield c;
}

/** Every visible item at or under `item`. */
function visible(item: Y.Item, out: IdSpan[]) {
  if (item.deleted) return;
  out.push(spanOf(item));
  for (const c of children(item)) visible(c, out);
}

/** Every tombstone at or under `item`. */
function tombstones(item: Y.Item, out: IdSpan[]) {
  if (item.deleted) out.push(spanOf(item));
  for (const c of children(item)) tombstones(c, out);
}

/** Visible items covering content offsets [a, b) of a textblock element. */
function visibleBetween(block: Y.Item, a: number, b: number, out: IdSpan[]) {
  let pos = 0;
  const take = (item: Y.Item, size: number) => {
    const lo = Math.max(a, pos);
    const hi = Math.min(b, pos + size);
    if (lo < hi) out.push(spanOf(item, lo - pos, hi - pos));
    pos += size;
  };
  for (const child of children(block)) {
    if (child.deleted) continue;
    if (child.content instanceof Y.ContentType && child.content.type instanceof Y.XmlText) {
      for (let c = child.content.type._start; c; c = c.right) {
        if (!c.deleted && c.countable) take(c, c.length);
        if (pos >= b) return;
      }
    } else take(child, 1);
    if (pos >= b) return;
  }
}

interface DraftBlocks {
  items: Y.Item[]; // visible top-level elements, index-aligned with the draft's blocks
  gaps: Y.Item[][]; // tombstones before block i; the last entry follows the last block
}

function draftBlocks(fragment: Y.XmlFragment): DraftBlocks {
  const items: Y.Item[] = [];
  const gaps: Y.Item[][] = [[]];
  for (let it = fragment._start; it; it = it.right) {
    if (it.deleted) gaps[gaps.length - 1].push(it);
    else if (it.content instanceof Y.ContentType && it.content.type instanceof Y.XmlElement) {
      items.push(it);
      gaps.push([]);
    }
  }
  return { items, gaps };
}

function groupEvidence(
  group: ReviewGroup,
  { blockStarts }: ReviewProjection,
  blocks: DraftBlocks,
): { green: IdSpan[]; dead: IdSpan[] } {
  const green: IdSpan[] = [];
  const dead: IdSpan[] = [];
  for (const h of group.hunks) {
    if (!h.inserted) continue;
    const { from, to } = h.inserted;
    for (let i = 0; i < blocks.items.length; i++) {
      const bs = blockStarts[i];
      const be = blockStarts[i + 1];
      if (be <= from) continue;
      if (bs >= to) break;
      const item = blocks.items[i];
      if (from <= bs && to >= be) visible(item, green);
      else {
        if (from <= bs) green.push(spanOf(item));
        visibleBetween(
          item,
          Math.max(from, bs + 1) - (bs + 1),
          Math.min(to, be - 1) - (bs + 1),
          green,
        );
      }
    }
  }
  for (const span of group.spans) {
    const { from, to } = span.draft;
    if (from === to) for (const t of blocks.gaps[from] ?? []) tombstones(t, dead);
    for (let i = from; i < to; i++) {
      if (blocks.items[i]) tombstones(blocks.items[i], dead);
      if (i > from) for (const t of blocks.gaps[i] ?? []) tombstones(t, dead);
    }
  }
  return { green, dead };
}

interface PreparedEdit {
  inserted: RangeSet;
  deleted: RangeSet;
}
const prepare = (e: AttributionEdit): PreparedEdit => ({
  inserted: new RangeSet(e.inserted),
  deleted: new RangeSet(e.deleted),
});

/** Per group id, the indexes of `edits` whose ranges overlap it. */
function overlaps(
  fragment: Y.XmlFragment,
  projection: ReviewProjection,
  edits: readonly PreparedEdit[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!edits.length) return out;
  const blocks = draftBlocks(fragment);
  // A fragment that moved on since the projection was computed no longer lines up block for block.
  if (blocks.items.length !== projection.blockStarts.length - 1) return out;
  for (const group of projection.groups) {
    const { green, dead } = groupEvidence(group, projection, blocks);
    const hits = edits.flatMap((e, i) =>
      green.some((s) => e.inserted.overlaps(s.client, s.lo, s.hi)) ||
      dead.some((s) => e.deleted.overlaps(s.client, s.lo, s.hi))
        ? [i]
        : [],
    );
    if (hits.length) out.set(group.id, hits);
  }
  return out;
}

/** Per group id, the chats whose edits overlap it, latest first, one entry per chat. */
export function matchAttribution(
  fragment: Y.XmlFragment,
  projection: ReviewProjection,
  edits: readonly AttributionEdit[],
): Map<string, ChatHint[]> {
  const ordered = edits
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => (Number.isNaN(a.t) || Number.isNaN(b.t) ? a.i - b.i : b.t - a.t))
    .map(({ e }) => e);
  const out = new Map<string, ChatHint[]>();
  for (const [groupId, hits] of overlaps(fragment, projection, ordered.map(prepare))) {
    const hints: ChatHint[] = [];
    for (const i of hits) {
      const { threadId, title, turnId, at } = ordered[i];
      if (!hints.some((h) => h.threadId === threadId)) hints.push({ threadId, title, turnId, at });
    }
    out.set(groupId, hints);
  }
  return out;
}

/** Which of `edits` lie inside some review change (true) and which are in no change (false). */
export function editsInChanges(
  fragment: Y.XmlFragment,
  projection: ReviewProjection,
  edits: readonly AttributionEdit[],
): boolean[] {
  const inside = edits.map(() => false);
  for (const hits of overlaps(fragment, projection, edits.map(prepare)).values())
    for (const i of hits) inside[i] = true;
  return inside;
}
