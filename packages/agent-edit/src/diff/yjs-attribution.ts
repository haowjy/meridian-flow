/**
 * Who made each review group, read from the draft's Yjs items: the chats whose AI writes made it
 * and whether the writer did.
 *
 * The payload (`edits`) lists, per AI edit part, the item ranges it inserted and deleted. The evidence
 * for a group is what its hunks themselves altered: the visible items a hunk made new (a hunk-local
 * character diff drops the unchanged characters around a typed letter), and the tombstones that sit
 * exactly where the hunk's deletion lies (between the visible items bounding that point, or in the gap
 * where a block went). A green item in an edit's `inserted`, or a red tombstone in its `deleted`, names
 * that edit's chat. Any evidence item no edit accounts for is the writer's: in a draft, everything
 * else is their typing, late-peer recovery, or Discard and its Undo.
 *
 * Yjs records no deleter, so a deletion point holding more tombstones than the hunk removed is
 * ambiguous: its tombstones name no chat (they can still show the writer). A hunk whose text could
 * slide onto an identical neighbour (repeated words) has no evidence at all. A missing name is better
 * than a wrong one. This is a hint for a card's byline: nothing gates on it.
 */
import { DIFF_DELETE, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";
import * as Y from "yjs";
import type { Hunk } from "./hunks.js";
import type { ReviewProjection } from "./review.js";
import { DIFF_OPTS, isBlockTok, type Side, type Tok } from "./tokens.js";

export type ItemRange = readonly [client: number, clock: number, length: number];

export interface AttributionEdit {
  threadId: string;
  title: string;
  turnId: string;
  toolCallId?: string;
  at: string;
  inserted: readonly ItemRange[];
  deleted: readonly ItemRange[];
}
export type ChatHint = Pick<AttributionEdit, "threadId" | "title" | "turnId" | "toolCallId" | "at">;
/** Who made one change: the writer (some evidence no AI part accounts for) and the chats, latest first. */
export interface ChangeAttribution {
  writer: boolean;
  chats: ChatHint[];
}

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
  /** Whether every id in [lo, hi) is in the set (merged intervals make that one interval). */
  covers(client: number, lo: number, hi: number): boolean {
    const list = this.byClient.get(client);
    if (!list) return false;
    let a = 0;
    let b = list.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (list[m][1] <= lo) a = m + 1;
      else b = m;
    }
    return a < list.length && list[a][0] <= lo && hi <= list[a][1];
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

/** One piece of what a hunk altered. `blur`: a deletion point that holds more tombstones than the hunk removed. */
interface Evidence {
  span: IdSpan;
  dead: boolean;
  blur: boolean;
}

/** A textblock's content laid out by offset: its visible units and the tombstones between them. */
interface BlockIndex {
  units: Array<{ lo: number; hi: number; item: Y.Item }>;
  dead: Array<{ at: number; item: Y.Item }>;
  size: number;
}

function indexBlock(block: Y.Item): BlockIndex {
  const units: BlockIndex["units"] = [];
  const dead: BlockIndex["dead"] = [];
  let pos = 0;
  for (const child of children(block)) {
    if (child.deleted) dead.push({ at: pos, item: child });
    else if (child.content instanceof Y.ContentType && child.content.type instanceof Y.XmlText) {
      for (let c = child.content.type._start; c; c = c.right) {
        if (c.deleted) {
          if (!(c.content instanceof Y.ContentFormat)) dead.push({ at: pos, item: c });
        } else if (c.countable) {
          units.push({ lo: pos, hi: pos + c.length, item: c });
          pos += c.length;
        }
      }
    } else {
      units.push({ lo: pos, hi: pos + 1, item: child });
      pos++;
    }
  }
  return { units, dead, size: pos };
}

const OBJECT = "\uFFFC";
const tokSize = (t: Tok) =>
  t.kind === "text" ? t.ws.length + t.core.length : t.kind === "inline" ? t.node.nodeSize : 0;
const tokText = (t: Tok) => (t.kind === "text" ? t.ws + t.core : t.kind === "inline" ? OBJECT : "");
/** Two text tokens that read the same: moving a hunk across one gives the same document. */
const alike = (a: Tok | undefined, b: Tok | undefined) =>
  !!a && !!b && !isBlockTok(a) && !isBlockTok(b) && a.key === b.key;
/** Character-diff budget: past this a hunk keeps all its inserted text as evidence. */
const REFINE_LIMIT = 20_000;

/** The draft side of the projection, with each textblock indexed the first time a hunk reads it. */
class DraftView {
  private offsets = new Map<number, Int32Array>();
  private indexes = new Map<number, BlockIndex>();
  constructor(
    readonly side: Side,
    readonly blocks: DraftBlocks,
  ) {}

  /** Content offset where token `p` begins in its block. */
  offset(p: number): number {
    const b = this.side.blockOf[p];
    let o = this.offsets.get(b);
    if (!o) {
      const { toks, starts } = this.side;
      o = new Int32Array(starts[b + 1] - starts[b] + 1);
      let at = 0;
      for (let i = starts[b]; i < starts[b + 1]; i++) {
        o[i - starts[b]] = at;
        at += tokSize(toks[i]);
      }
      o[o.length - 1] = at;
      this.offsets.set(b, o);
    }
    return o[p - this.side.starts[b]];
  }

  /** Content size of block `b`. */
  size(b: number): number {
    return this.index(b).size;
  }

  index(b: number): BlockIndex {
    let i = this.indexes.get(b);
    if (!i) {
      i = indexBlock(this.blocks.items[b]);
      this.indexes.set(b, i);
    }
    return i;
  }

  /** The visible items covering content offsets [lo, hi) of block `b`. */
  fresh(b: number, lo: number, hi: number, out: Evidence[]) {
    const { units } = this.index(b);
    let a = 0;
    let z = units.length;
    while (a < z) {
      const m = (a + z) >> 1;
      if (units[m].hi <= lo) a = m + 1;
      else z = m;
    }
    for (; a < units.length && units[a].lo < hi; a++) {
      const u = units[a];
      const span = spanOf(u.item, Math.max(lo, u.lo) - u.lo, Math.min(hi, u.hi) - u.lo);
      out.push({ span, dead: false, blur: false });
    }
  }

  /** The tombstones lying at content offsets [lo, hi] of block `b`. */
  tombs(b: number, lo: number, hi: number): Y.Item[] {
    return this.index(b)
      .dead.filter((d) => d.at >= lo && d.at <= hi)
      .map((d) => d.item);
  }
}

/** `chars` removed characters whose deletion point offers `items`: more than that and the point is shared. */
function pushTombs(items: Y.Item[], chars: number, out: Evidence[]) {
  const spans: IdSpan[] = [];
  let total = 0;
  for (const item of items) {
    total += item.length;
    tombstones(item, spans);
  }
  for (const span of spans) out.push({ span, dead: true, blur: total > chars });
}

/** The change's evidence from one hunk. */
function hunkEvidence(h: Hunk, base: Side, view: DraftView, out: Evidence[]) {
  const D = view.side;
  const rem = base.toks.slice(h.from, h.to);
  const ins = h.ins;
  const q = h.sfrom;
  const qEnd = q + ins.length;

  // A pure insertion or deletion that could slide onto an identical neighbour has no known place.
  if (!ins.length && rem.length) {
    if (
      alike(base.toks[h.from - 1], base.toks[h.to - 1]) ||
      alike(base.toks[h.from], base.toks[h.to])
    )
      return;
  } else if (ins.length && !rem.length) {
    if (alike(D.toks[q - 1], D.toks[qEnd - 1]) || alike(D.toks[qEnd], D.toks[q])) return;
  }

  const pairedBlock = rem.some(isBlockTok);
  // Draft runs of text the hunk wrote, and the text it replaced (the part before any removed block).
  const runs: Array<{ b: number; off: number; at: number; size: number }> = [];
  let insText = "";
  for (let p = q; p < qEnd; p++) {
    const t = D.toks[p];
    const b = D.blockOf[p];
    if (t.kind === "atom") {
      const spans: IdSpan[] = [];
      visible(view.blocks.items[b], spans);
      for (const span of spans) out.push({ span, dead: false, blur: false });
    } else if (t.kind === "block") {
      const item = view.blocks.items[b];
      if (!pairedBlock) out.push({ span: spanOf(item), dead: false, blur: false });
      else if (item.content instanceof Y.ContentType)
        for (const attr of item.content.type._map.values())
          if (!attr.deleted) out.push({ span: spanOf(attr), dead: false, blur: false });
    } else {
      runs.push({ b, off: view.offset(p), at: insText.length, size: tokSize(t) });
      insText += tokText(t);
    }
  }
  let remText = "";
  for (const t of rem) {
    if (isBlockTok(t)) break;
    remText += tokText(t);
  }

  const locate = (i: number): [block: number, offset: number] => {
    let run = runs[0];
    for (const r of runs) if (r.at <= i) run = r;
    return [run.b, run.off + Math.min(i - run.at, run.size)];
  };
  const green = (lo: number, hi: number) => {
    for (const r of runs) {
      const a = Math.max(lo, r.at);
      const z = Math.min(hi, r.at + r.size);
      if (a < z) view.fresh(r.b, r.off + a - r.at, r.off + z - r.at, out);
    }
  };

  if (insText && !remText) green(0, insText.length);
  else if (insText && insText.length + remText.length > REFINE_LIMIT) green(0, insText.length);
  else if (insText) {
    const ops = makeDiff(remText, insText, DIFF_OPTS);
    let at = 0; // index in insText
    let from = 0; // index in remText
    ops.forEach(([op, text], k) => {
      const n = text.length;
      if (op === DIFF_INSERT) {
        const slides =
          (at > 0 && insText[at - 1] === insText[at + n - 1]) ||
          (at + n < insText.length && insText[at + n] === insText[at]);
        if (!slides) green(at, at + n);
        at += n;
      } else if (op === DIFF_DELETE) {
        const slides =
          (from > 0 && remText[from - 1] === remText[from + n - 1]) ||
          (from + n < remText.length && remText[from + n] === remText[from]);
        if (!slides) {
          // The tombstone sits beside whichever of a replaced pair was written first.
          const points = new Set([at]);
          if (ops[k + 1]?.[0] === DIFF_INSERT) points.add(at + ops[k + 1][1].length);
          if (ops[k - 1]?.[0] === DIFF_INSERT) points.add(at - ops[k - 1][1].length);
          const items: Y.Item[] = [];
          for (const point of points) {
            const [b, off] = locate(point);
            items.push(...view.tombs(b, off, off));
          }
          pushTombs(items, n, out);
        }
        from += n;
      } else {
        at += n;
        from += n;
      }
    });
  } else if (remText) {
    // Text removed with nothing written in its place: the point is where the next draft token begins.
    const next = D.toks[q];
    if (next && !isBlockTok(next)) {
      const off = view.offset(q);
      pushTombs(
        view.tombs(D.blockOf[q], off, off + (next.kind === "text" ? next.ws.length : 0)),
        remText.length,
        out,
      );
    } else if (q > 0 && D.toks[q - 1].kind !== "atom") {
      const b = D.blockOf[q - 1];
      pushTombs(view.tombs(b, view.size(b), view.size(b)), remText.length, out);
    }
  }

  const removedBlocks = rem.filter(isBlockTok).length;
  if (removedBlocks) {
    // A removed block took its place in the gap where the draft's next block starts.
    const gap =
      q >= D.toks.length
        ? view.blocks.items.length
        : isBlockTok(D.toks[q])
          ? D.blockOf[q]
          : D.blockOf[q] + 1;
    const gone = view.blocks.gaps[gap] ?? [];
    for (const t of gone)
      out.push({ span: spanOf(t), dead: true, blur: gone.length > removedBlocks });
  }
}

interface PreparedEdit {
  inserted: RangeSet;
  deleted: RangeSet;
}
const prepare = (e: AttributionEdit): PreparedEdit => ({
  inserted: new RangeSet(e.inserted),
  deleted: new RangeSet(e.deleted),
});

interface Verdict {
  writer: boolean;
  /** Indexes of `edits` whose ranges lie in the group's evidence, blurred points included. */
  hits: number[];
  /** The same without the evidence that cannot tell which deletion it came from. */
  named: number[];
}

/** One evidence pass: per group id, who made it. Indexes refer to `edits`. */
function attribute(
  fragment: Y.XmlFragment,
  projection: ReviewProjection,
  edits: readonly AttributionEdit[],
): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const blocks = draftBlocks(fragment);
  // A fragment that moved on since the projection was computed no longer lines up block for block.
  if (blocks.items.length !== projection.blockStarts.length - 1) return out;
  const prepared = edits.map(prepare);
  const insAll = new RangeSet(edits.flatMap((e) => e.inserted));
  const delAll = new RangeSet(edits.flatMap((e) => e.deleted));
  const view = new DraftView(projection.diff.draft, blocks);
  for (const group of projection.groups) {
    const evidence: Evidence[] = [];
    for (const h of group.hunks)
      hunkEvidence(projection.diff.hunks[h.index], projection.diff.base, view, evidence);
    if (!evidence.length) continue;
    const verdict: Verdict = { writer: false, hits: [], named: [] };
    for (const { span: s, dead, blur } of evidence)
      if (!(dead ? delAll : insAll).covers(s.client, s.lo, s.hi)) verdict.writer = true;
    prepared.forEach((e, i) => {
      const set = (dead: boolean) => (dead ? e.deleted : e.inserted);
      if (evidence.some((v) => set(v.dead).overlaps(v.span.client, v.span.lo, v.span.hi)))
        verdict.hits.push(i);
      if (
        evidence.some((v) => !v.blur && set(v.dead).overlaps(v.span.client, v.span.lo, v.span.hi))
      )
        verdict.named.push(i);
    });
    out.set(group.id, verdict);
  }
  return out;
}

/** Per group id with evidence: whether the writer made it and the chats whose edits did, latest first. */
export function matchAttribution(
  fragment: Y.XmlFragment,
  projection: ReviewProjection,
  edits: readonly AttributionEdit[],
): Map<string, ChangeAttribution> {
  const ordered = edits
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => (Number.isNaN(a.t) || Number.isNaN(b.t) ? a.i - b.i : b.t - a.t))
    .map(({ e }) => e);
  const out = new Map<string, ChangeAttribution>();
  for (const [groupId, { writer, named }] of attribute(fragment, projection, ordered)) {
    const chats: ChatHint[] = [];
    for (const i of named) {
      const { threadId, title, turnId, toolCallId, at } = ordered[i];
      if (!chats.some((h) => h.threadId === threadId))
        chats.push({ threadId, title, turnId, ...(toolCallId ? { toolCallId } : {}), at });
    }
    out.set(groupId, { writer, chats });
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
  for (const { hits } of attribute(fragment, projection, edits).values())
    for (const i of hits) inside[i] = true;
  return inside;
}
