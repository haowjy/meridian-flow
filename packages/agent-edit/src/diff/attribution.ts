/**
 * Who wrote each review change, read from the draft's Yjs items. One classifier, one provenance input,
 * three rules (design: attribution-design.md):
 *
 * - Byline: a change names an author when, for one of its edits, every alignment the items can account
 *   for gives that author part of the edit. Under doubt it names fewer, down to none.
 * - Membership: a change belongs to a conversation when any alignment of any of its edits puts one of
 *   that conversation's AI writes in it. Under doubt it includes.
 * - Status: an AI part reads applied only when no change has it as a member.
 *
 * An alignment is one place the text allows an edit to sit (a repeated word or a boundary space can
 * slide). The classifier works on the character edit of each hunk, never on its word tokens, and reads
 * only lengths, ids and restoration links, so a browser (gc on) and the server (gc off) agree.
 */

import type { Author } from "@meridian/contracts/drafts";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";
import * as Y from "yjs";
import { type ApplyEntry, readApplyRecord } from "./apply-record.js";
import { DRAFT_SERVER_CLIENT_ID } from "./draft-base.js";
import type { Hunk } from "./hunks.js";
import { IdIndex, type ItemRange, indexRanges } from "./id-index.js";
import { type RestorationLink, readRestorationLinks } from "./restorations.js";
import type { ReviewProjection } from "./review.js";
import { DIFF_OPTS, isBlockTok, type Side, type Tok } from "./tokens.js";

export type { ItemRange } from "./id-index.js";
export type { Author };

/** One AI write: the item ranges it inserted and deleted. Parts are listed latest first. */
export interface AttributionPart {
  threadId: string;
  turnId: string;
  toolCallId?: string;
  inserted: readonly ItemRange[];
  deleted: readonly ItemRange[];
}
export interface Provenance {
  /** The human who owns the draft's browser clients (`projects.user_id` while a project has one user). */
  userId: string;
  parts: readonly AttributionPart[];
}
export interface ChangeClassification {
  /** The user first, then each writing thread once (linking to its latest write). */
  byline: Author[];
  /** Indexes of `parts` that are in the change under any alignment. */
  members: number[];
  /** With `record`: what Apply moves into the base if this change is applied. */
  applied?: ApplyEntry;
}
export interface ClassifyOptions {
  /** Characters of span the classification may diff (default 64k). */
  budget?: number;
  /** Also return each change's Apply record. */
  record?: boolean;
  /** Characters a repeated-text slide may scan each way before the exact byline gives way to membership (tests lower it). */
  slide?: number;
}

const DIFF_BUDGET = 64_000;
const SLIDE_SCAN = 4096;
/** Alignment work (alignments times characters) one op may cost before it is left unnamed. */
const SLIDE_WORK = 200_000;
const OBJECT = "￼";
const BASE = -1;
const USER = -2;
/** Provenance a restoration chain could not settle. Names no one, and is never the writer's. */
const UNKNOWN = -3;
const isUnknown = (who: number) => who === UNKNOWN;

const tokStr = (t: Tok) => (t.kind === "text" ? t.ws + t.core : t.kind === "inline" ? OBJECT : "");

/** A block's content laid out by character offset. */
interface BlockIx {
  units: Array<{ at: number; item: Y.Item }>;
  dead: Array<{ at: number; item: Y.Item }>;
  /** Live format items by offset. */
  formats: Array<{ at: number; item: Y.Item }>;
  /** The draft text the offsets address; `bad` when the walk and the projection disagree on its length. */
  text: string;
  bad: boolean;
}

function walkBlock(block: Y.Item, text: string, nested: boolean): BlockIx {
  const ix: BlockIx = { units: [], dead: [], formats: [], text, bad: false };
  let pos = 0;
  const visit = (type: { _start: Y.Item | null }, inText: boolean) => {
    for (let c = type._start; c; c = c.right) {
      // A browser's gc turns a deleted format into a deleted unit of unknown kind, so both sides list it as dead.
      if (c.deleted) ix.dead.push({ at: pos, item: c });
      else if (c.content instanceof Y.ContentFormat) ix.formats.push({ at: pos, item: c });
      else if (c.content instanceof Y.ContentType) {
        const inner = c.content.type;
        if (inner instanceof Y.XmlText || (nested && !inText))
          visit(inner, inner instanceof Y.XmlText);
        else {
          ix.units.push({ at: pos, item: c });
          pos++;
        }
      } else if (c.countable) {
        ix.units.push({ at: pos, item: c });
        pos += c.length;
      }
    }
  };
  if (block.content instanceof Y.ContentType) visit(block.content.type, false);
  ix.bad = pos !== text.length;
  return ix;
}

const marked = (t: Tok) => t.kind === "text" && (t.marks.length > 0 || !!t.wsMarks?.length);

/** Index of the first entry whose `at` is at least `at`. */
function lowerBound(list: ReadonlyArray<{ at: number }>, at: number): number {
  let a = 0;
  let b = list.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (list[m].at < at) a = m + 1;
    else b = m;
  }
  return a;
}

/** The offsets `[lo, hi]` an insert of `n` characters at `start` could sit at, and whether the scan ran out. */
function slideInsert(text: string, start: number, n: number, cap: number) {
  let lo = start;
  let hi = start;
  while (lo > 0 && text[lo - 1] === text[lo + n - 1] && start - lo < cap) lo--;
  while (hi + n < text.length && text[hi] === text[hi + n] && hi - start < cap) hi++;
  return { lo, hi, cut: start - lo >= cap || hi - start >= cap };
}

/** The offsets `[lo, hi]` a deletion of `removed` at `p` could sit at; the removed text rotates as it slides. */
function slideDelete(text: string, p: number, removed: string, cap: number) {
  const m = removed.length;
  let lo = p;
  let hi = p;
  while (lo > 0 && p - lo < cap && text[lo - 1] === removed[(((m - 1 - (p - lo)) % m) + m) % m])
    lo--;
  while (hi < text.length && hi - p < cap && text[hi] === removed[(hi - p) % m]) hi++;
  return { lo, hi, cut: p - lo >= cap || hi - p >= cap };
}

/** The hunk's token range split at block tokens: a leading run of text, then one segment per block. */
function segments(toks: readonly Tok[], lo: number, hi: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = lo;
  for (let i = lo; i < hi; i++)
    if (isBlockTok(toks[i])) {
      out.push([start, i]);
      start = i;
    }
  out.push([start, hi]);
  return out;
}

/** The names a change has gathered so far; thread names keep the index of their latest part. */
interface Acc {
  names: Map<string, number>;
  members: Set<number>;
  base: ItemRange[];
  settled: ItemRange[];
}

/** Sorted, with overlapping and touching ranges joined (the same item is reached by several alignments). */
function joined(ranges: readonly ItemRange[]): ItemRange[] {
  const out: ItemRange[] = [];
  for (const [client, clock, len] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last && last[0] === client && clock <= last[1] + last[2])
      out[out.length - 1] = [client, last[1], Math.max(last[1] + last[2], clock + len) - last[1]];
    else out.push([client, clock, len]);
  }
  return out;
}

const pushRange = (out: ItemRange[], client: number, clock: number, len = 1) => {
  const last = out[out.length - 1];
  if (last && last[0] === client && last[1] + last[2] === clock)
    out[out.length - 1] = [client, last[1], last[2] + len];
  else out.push([client, clock, len]);
};

/** Resolved provenance by item id. */
class IdMemo {
  private readonly byClient = new Map<number, Map<number, number>>();
  get(client: number, clock: number): number | undefined {
    return this.byClient.get(client)?.get(clock);
  }
  set(client: number, clock: number, who: number) {
    const clocks = this.byClient.get(client);
    if (clocks) clocks.set(clock, who);
    else this.byClient.set(client, new Map([[clock, who]]));
  }
}

class Classifier {
  private readonly parts: readonly AttributionPart[];
  private readonly inserted: IdIndex;
  private readonly deleted: IdIndex;
  private readonly applied: IdIndex;
  private readonly settled: IdIndex;
  private readonly links: IdIndex;
  private readonly superseded: IdIndex;
  private readonly linkList: readonly RestorationLink[];
  private budget: number;
  private readonly slide: number;
  private readonly blocks: { items: Y.Item[]; gaps: Y.Item[][] };
  private readonly indexes = new Map<number, BlockIx>();
  private readonly texts = [new Map<number, SideText>(), new Map<number, SideText>()] as const;
  private readonly originMemo = new IdMemo();
  private readonly deleterMemo = new IdMemo();

  constructor(
    private readonly doc: Y.Doc,
    private readonly projection: ReviewProjection,
    private readonly provenance: Provenance,
    private readonly options: ClassifyOptions,
  ) {
    this.parts = provenance.parts;
    this.budget = options.budget ?? DIFF_BUDGET;
    this.slide = options.slide ?? SLIDE_SCAN;
    this.inserted = indexRanges(this.parts.map((p) => p.inserted));
    this.deleted = indexRanges(this.parts.map((p) => p.deleted));
    const record = readApplyRecord(doc);
    this.applied = indexRanges([record.flatMap((e) => e.base)]);
    this.settled = indexRanges([record.flatMap((e) => e.settled)]);
    this.linkList = readRestorationLinks(doc);
    this.links = new IdIndex(this.linkList.map((l, i) => [l[0], l[1], l[2], i] as const));
    this.superseded = indexRanges([this.linkList.map((l) => [l[3], l[4], l[2]] as const)]);
    const items: Y.Item[] = [];
    const gaps: Y.Item[][] = [[]];
    for (let it = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)._start; it; it = it.right) {
      if (it.deleted) gaps[gaps.length - 1].push(it);
      else if (it.content instanceof Y.ContentType && it.content.type instanceof Y.XmlElement) {
        items.push(it);
        gaps.push([]);
      }
    }
    this.blocks = { items, gaps };
  }

  /** Whether the fragment still lines up block for block with the projection. */
  get aligned() {
    return this.blocks.items.length === this.projection.diff.draft.blocks.length;
  }

  // ---- provenance ----

  private link(client: number, clock: number): [number, number] | null {
    const l = this.links.get(client, clock);
    if (l < 0) return null;
    const link = this.linkList[l];
    return [link[3], link[4] + (clock - link[1])];
  }

  /**
   * Follows restoration links from an item to the item that wrote it. Links point at earlier items, so
   * the walk ends; what it proves is kept, so a long chain is walked once.
   */
  private chase(
    client: number,
    clock: number,
    memo: IdMemo,
    end: (client: number, clock: number) => number | undefined,
    unlinked: number,
  ): number {
    let c = client;
    let k = clock;
    let path: Array<[number, number]> | null = null;
    let who: number;
    for (let hops = 0; ; hops++) {
      const known = memo.get(c, k) ?? end(c, k);
      if (known !== undefined) {
        who = known;
        break;
      }
      const to = this.link(c, k);
      if (!to) {
        who = unlinked;
        break;
      }
      if (hops > this.linkList.length) {
        who = UNKNOWN;
        break;
      }
      path ??= [];
      path.push([c, k]);
      [c, k] = to;
    }
    if (path) for (const [pc, pk] of path) memo.set(pc, pk, who);
    return who;
  }

  /** `BASE`, `USER`, `UNKNOWN`, or the index of the AI part that wrote the item. */
  private origin(client: number, clock: number): number {
    return this.chase(
      client,
      clock,
      this.originMemo,
      (c, k) => {
        if (this.applied.get(c, k) >= 0) return BASE;
        const part = this.inserted.get(c, k);
        if (part >= 0) return part;
        return c === DRAFT_SERVER_CLIENT_ID ? BASE : undefined;
      },
      USER,
    );
  }

  /** The AI part that deleted the tombstone, else the user. */
  private deleter(client: number, clock: number): number {
    return this.chase(
      client,
      clock,
      this.deleterMemo,
      (c, k) => {
        const part = this.deleted.get(c, k);
        return part >= 0 ? part : undefined;
      },
      USER,
    );
  }

  private keyOf = (who: number) => (who === USER ? "user" : `thread:${this.parts[who].threadId}`);

  private name(acc: Acc, who: number) {
    const key = this.keyOf(who);
    const seen = acc.names.get(key);
    acc.names.set(key, seen === undefined ? who : Math.min(seen, who));
    if (who >= 0) acc.members.add(who);
  }

  // ---- layout ----

  private text(side: 0 | 1, b: number): SideText {
    let t = this.texts[side].get(b);
    if (!t) {
      const s = side ? this.projection.diff.draft : this.projection.diff.base;
      t = new SideText(s, b);
      this.texts[side].set(b, t);
    }
    return t;
  }

  private index(b: number): BlockIx {
    let ix = this.indexes.get(b);
    if (!ix) {
      const text = this.text(1, b);
      ix = walkBlock(this.blocks.items[b], text.text, text.atom);
      this.indexes.set(b, ix);
    }
    return ix;
  }

  private eachChar(
    ix: BlockIx,
    from: number,
    to: number,
    fn: (client: number, clock: number, item: Y.Item) => void,
  ) {
    let u = lowerBound(ix.units, from + 1) - 1;
    for (let pos = from; pos < to; ) {
      while (u + 1 < ix.units.length && ix.units[u + 1].at <= pos) u++;
      const unit = ix.units[u];
      if (!unit) return;
      const end = Math.min(to, unit.at + unit.item.length);
      for (; pos < end; pos++)
        fn(unit.item.id.client, unit.item.id.clock + (pos - unit.at), unit.item);
    }
  }

  // ---- evidence ----
  //
  // One route. Every item a change touches goes through `touch` (live items) or `tombs` (deleted ones):
  // that is where membership and the Apply record grow, and neither depends on how exactly the edit could
  // be placed. Only the names are exact, and they come from the alignments that were affordable.

  /** A live item of the change: its part is a member, Apply moves it, and `named` lets it name its author. */
  private touch(acc: Acc, who: number, client: number, clock: number, named: boolean) {
    if (who === BASE) return;
    if (who >= 0) acc.members.add(who);
    if (this.options.record) pushRange(acc.base, client, clock);
    if (named && !isUnknown(who)) this.name(acc, who);
  }

  /** A single-unit item that is the change itself (an element, a format, an attribute): it names its author. */
  private evidence(acc: Acc, item: Y.Item) {
    const { client, clock } = item.id;
    this.touch(acc, this.origin(client, clock), client, clock, true);
  }

  /** Tombstones of the change: the parts that deleted them are members and Apply settles them. */
  private tombs(acc: Acc, items: readonly Y.Item[], deleters?: number[]) {
    for (const item of items)
      for (let k = 0; k < item.length; k++) {
        const c = item.id.client;
        const clock = item.id.clock + k;
        if (this.settled.get(c, clock) >= 0) continue;
        if (this.options.record) pushRange(acc.settled, c, clock);
        const part = this.deleted.get(c, clock);
        if (part >= 0) acc.members.add(part);
        if (deleters && this.origin(c, clock) === BASE && this.superseded.get(c, clock) < 0)
          deleters.push(this.deleter(c, clock));
      }
  }

  /** Everything in offsets `[from, to]` of block `b`: the span nobody could place exactly. */
  private region(
    acc: Acc,
    b: number,
    from: number,
    to: number,
    what: { live: boolean; dead: boolean },
  ) {
    const ix = this.index(b);
    if (what.live)
      this.eachChar(ix, from, to, (c, k, item) => this.touch(acc, this.origin(c, k), c, k, false));
    if (!what.dead) return;
    const dead: Y.Item[] = [];
    for (let i = lowerBound(ix.dead, from); i < ix.dead.length && ix.dead[i].at <= to; i++)
      dead.push(ix.dead[i].item);
    this.tombs(acc, dead);
  }

  /** Green: `n` characters at `start` of draft block `b` are new. */
  private green(acc: Acc, b: number, start: number, n: number) {
    const ix = this.index(b);
    if (ix.bad) return this.region(acc, b, start, start + n, { live: true, dead: false });
    const { lo, hi, cut } = slideInsert(ix.text, start, n, this.slide);
    if (cut) return this.region(acc, b, 0, ix.text.length, { live: true, dead: false });
    if ((hi - lo + 1) * n > SLIDE_WORK)
      return this.region(acc, b, lo, hi + n, { live: true, dead: false });
    const all: Array<Set<number>> = [];
    for (let p = lo; p <= hi; p++) {
      const origins = new Set<number>();
      this.eachChar(ix, p, p + n, (c, k, item) => {
        const who = this.origin(c, k);
        origins.add(who);
        this.touch(acc, who, c, k, false);
      });
      all.push(origins);
    }
    // An alignment that lands on base text cannot be the insert: the base contained that text already.
    const valid = all.filter((o) => !o.has(BASE));
    this.nameCommon(
      acc,
      (valid.length ? valid : all).map((o) => this.keyed([...o].filter((w) => w !== BASE))),
    );
  }

  /** Red: `weight` characters (or blocks) were removed; each point is the tombstones where they may sit. */
  private red(acc: Acc, points: Array<readonly Y.Item[]>, weight: number) {
    const valid: Array<Map<string, number>> = [];
    for (const tombs of points) {
      const deleters: number[] = [];
      this.tombs(acc, tombs, deleters);
      if (deleters.length === weight) valid.push(this.keyed(deleters));
    }
    this.nameCommon(acc, valid);
  }

  /** Authors by key, each at its latest part (the lowest index); the user sorts first. An unknown vouches for no one. */
  private keyed(who: number[]): Map<string, number> {
    const out = new Map<string, number>();
    if (who.some(isUnknown)) return out;
    for (const w of who) out.set(this.keyOf(w), Math.min(out.get(this.keyOf(w)) ?? w, w));
    return out;
  }

  /** The authors every alignment agrees on. */
  private nameCommon(acc: Acc, alignments: Array<Map<string, number>>) {
    if (!alignments.length) return;
    for (const key of alignments[0].keys())
      if (alignments.every((m) => m.has(key)))
        this.name(acc, Math.min(...alignments.map((m) => m.get(key) as number)));
  }

  private deadAt(b: number, p: number): Y.Item[] {
    const { dead } = this.index(b);
    const out: Y.Item[] = [];
    for (let i = lowerBound(dead, p); i < dead.length && dead[i].at === p; i++)
      out.push(dead[i].item);
    return out;
  }

  /** `removed` was deleted from the draft at one of `starts` of block `b`'s text. */
  private deletion(acc: Acc, b: number, starts: number[], removed: string) {
    const ix = this.index(b);
    const spans: Array<[number, number]> = [];
    let cut = false;
    for (const s of starts) {
      if (ix.bad) spans.push([s, s]);
      else {
        const slid = slideDelete(ix.text, s, removed, this.slide);
        spans.push([slid.lo, slid.hi]);
        cut ||= slid.cut;
      }
    }
    const lo = Math.min(...spans.map(([x]) => x));
    const hi = Math.max(...spans.map(([, y]) => y));
    const points = new Set<number>();
    if (!cut) for (const [x, y] of spans) for (let p = x; p <= y; p++) points.add(p);
    if (cut || points.size * removed.length > SLIDE_WORK)
      return this.region(acc, b, cut ? 0 : lo, cut ? ix.text.length : hi, {
        live: false,
        dead: true,
      });
    this.red(
      acc,
      [...points].map((p) => this.deadAt(b, p)),
      removed.length,
    );
  }

  // ---- the character edit ----

  /**
   * The character edit between two spans. What the two share at both ends is trimmed first, so a one-word
   * edit never reaches diff-match-patch, and only what is left counts against the budget.
   */
  private diff(
    a: string,
    b: string,
  ): { ops: Array<[number, string]>; head: number; tail: number } | null {
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
    let hi = 0;
    while (
      hi < a.length - lo &&
      hi < b.length - lo &&
      a[a.length - 1 - hi] === b[b.length - 1 - hi]
    )
      hi++;
    const was = a.slice(lo, a.length - hi);
    const now = b.slice(lo, b.length - hi);
    const cost = was.length + now.length;
    if (cost > this.budget) return null;
    this.budget -= cost;
    const middle: Array<[number, string]> =
      !was || !now || (was.length === 1 && now.length === 1)
        ? [
            ...(was ? [[DIFF_DELETE, was] as [number, string]] : []),
            ...(now ? [[DIFF_INSERT, now] as [number, string]] : []),
          ]
        : (makeDiff(was, now, DIFF_OPTS) as Array<[number, string]>);
    return {
      ops: [
        ...(lo ? [[DIFF_EQUAL, a.slice(0, lo)] as [number, string]] : []),
        ...middle,
        ...(hi ? [[DIFF_EQUAL, a.slice(a.length - hi)] as [number, string]] : []),
      ],
      head: lo,
      tail: hi,
    };
  }

  /** The character edit of one span, `draft` starting at offset `ds` of draft block `b`. */
  private chars(acc: Acc, b: number, ds: number, base: string, draft: string) {
    const diffed = this.diff(base, draft);
    if (!diffed) return this.region(acc, b, ds, ds + draft.length, { live: true, dead: true });
    const { ops, head, tail } = diffed;
    let at = 0;
    ops.forEach(([op, txt], k) => {
      if (op === DIFF_INSERT) {
        this.green(acc, b, ds + at, txt.length);
        at += txt.length;
      } else if (op === DIFF_DELETE) {
        const starts = [at];
        if (ops[k + 1]?.[0] === DIFF_INSERT) starts.push(at + ops[k + 1][1].length);
        if (ops[k - 1]?.[0] === DIFF_INSERT) starts.push(at - ops[k - 1][1].length);
        this.deletion(
          acc,
          b,
          starts.map((s) => ds + s),
          txt,
        );
      } else if (op === DIFF_EQUAL) {
        // Items count, not characters the diff calls new: an equal character inside the edit ("e" of
        // red to blue) can still be a pending item, and the change owns it.
        if (at >= head && at + txt.length <= draft.length - tail)
          this.region(acc, b, ds + at, ds + at + txt.length, { live: true, dead: false });
        at += txt.length;
      }
    });
  }

  /** A removed attribute: Apply settles it, and the part that deleted it is a member and names itself. */
  private removed(acc: Acc, item: Y.Item) {
    this.tombs(acc, [item]);
    const who = this.deleter(item.id.client, item.id.clock);
    if (who >= 0) this.name(acc, who);
  }

  /** The mark rule: a hunk that only changed marks is evidenced by the format items it changed or removed. */
  private marks(
    acc: Acc,
    b: number,
    ds: number,
    de: number,
    rem: readonly Tok[],
    ins: readonly Tok[],
  ) {
    if (!rem.some(marked) && !ins.some(marked)) return;
    const names = (toks: readonly Tok[]) =>
      new Map(
        toks.flatMap((t) =>
          t.kind === "text"
            ? [...t.marks, ...(t.wsMarks ?? [])].map(
                (m) => [JSON.stringify(m.toJSON()), m.type.name] as const,
              )
            : [],
        ),
      );
    const was = names(rem);
    const now = names(ins);
    if (!was.size && !now.size) return;
    const changed = new Set(
      [...was, ...now].filter(([k]) => !(was.has(k) && now.has(k))).map(([, n]) => n),
    );
    if (!changed.size || !rem.length || !ins.length) return;
    const { formats, dead } = this.index(b);
    for (let i = lowerBound(formats, ds); i < formats.length && formats[i].at <= de; i++) {
      const { item } = formats[i];
      const key = (item.content as Y.ContentFormat).key;
      if ([...changed].some((n) => key === n || key.startsWith(`${n}--`))) this.evidence(acc, item);
    }
    // A removed mark is a deleted unit the draft no longer shows: whatever was deleted in the span is in the change.
    for (let i = lowerBound(dead, ds); i < dead.length && dead[i].at <= de; i++)
      this.tombs(acc, [dead[i].item]);
  }

  /** Every pending item of `item`'s subtree that is structure (elements, formats, attributes), and with `text` its characters. */
  private subtree(acc: Acc, item: Y.Item, text: boolean, named = false) {
    if (item.deleted) return;
    if (!(item.content instanceof Y.ContentString) || text)
      for (let k = 0; k < item.length; k++)
        this.touch(
          acc,
          this.origin(item.id.client, item.id.clock + k),
          item.id.client,
          item.id.clock + k,
          named,
        );
    if (!(item.content instanceof Y.ContentType)) return;
    const type = item.content.type;
    for (const attribute of type._map.values()) this.subtree(acc, attribute, text);
    for (let c = type._start; c; c = c.right) this.subtree(acc, c, text);
  }

  // ---- hunks ----

  private widen(
    side: Side,
    lo: number,
    hi: number,
    left: boolean,
    right: boolean,
  ): [number, number] {
    return [
      left && lo > 0 && !isBlockTok(side.toks[lo - 1]) ? lo - 1 : lo,
      right && hi < side.toks.length && !isBlockTok(side.toks[hi]) ? hi + 1 : hi,
    ];
  }

  /** The span `[lo, hi)` of tokens in block `b` of `side`, as text and the start offset. */
  private span(side: 0 | 1, b: number, lo: number, hi: number): { text: string; at: number } {
    const t = this.text(side, b);
    const start = (side ? this.projection.diff.draft : this.projection.diff.base).starts[b];
    const from = t.offsets[lo - start];
    return { text: t.text.slice(from, t.offsets[hi - start]), at: from };
  }

  /** The word-level hunks a cleaned hunk was built from: small spans, so the character diff stays small. */
  private pieces(h: Hunk): readonly Hunk[] {
    const { raw, hunks } = this.projection.diff;
    if (raw === hunks) return [h];
    let split = this.split;
    if (!split) {
      split = new Map();
      let r = 0;
      for (const cleaned of hunks) {
        const end = cleaned.sfrom + cleaned.ins.length;
        const mine: Hunk[] = [];
        while (r < raw.length) {
          const piece = raw[r++];
          mine.push(piece);
          if (piece.to === cleaned.to && piece.sfrom + piece.ins.length === end) break;
        }
        split.set(cleaned, mine);
      }
      this.split = split;
    }
    return split.get(h) ?? [h];
  }
  private split?: Map<Hunk, Hunk[]>;

  private hunk(acc: Acc, h: Hunk) {
    const { base: B, draft: D } = this.projection.diff;
    const q0 = h.sfrom;
    const q1 = q0 + h.ins.length;
    const sr = segments(B.toks, h.from, h.to);
    const si = segments(D.toks, q0, q1);
    let removed = 0;
    for (let k = 0; k < Math.max(sr.length, si.length); k++) {
      const r = sr[k];
      const i = si[k];
      if (k === 0) {
        if (!r || !i || (r[0] === r[1] && i[0] === i[1]) || h.from === 0 || q0 === 0) continue;
        if (B.toks[h.from - 1].kind === "atom" || D.toks[q0 - 1].kind === "atom") continue;
        const bb = B.blockOf[h.from - 1];
        const db = D.blockOf[q0 - 1];
        const [bl, bh] = this.widen(B, r[0], r[1], true, sr.length === 1);
        const [dl, dh] = this.widen(D, i[0], i[1], true, si.length === 1);
        const was = this.span(0, bb, bl, bh);
        const now = this.span(1, db, dl, dh);
        this.chars(acc, db, now.at, was.text, now.text);
        this.marks(
          acc,
          db,
          now.at,
          now.at + now.text.length,
          B.toks.slice(r[0], r[1]),
          D.toks.slice(i[0], i[1]),
        );
        continue;
      }
      const rAtom = r && B.toks[r[0]].kind === "atom";
      const iAtom = i && D.toks[i[0]].kind === "atom";
      if (r && i && rAtom === iAtom) {
        const bb = B.blockOf[r[0]];
        const db = D.blockOf[i[0]];
        if (rAtom) {
          // The text may be unchanged while the structure is not (a bullet list made ordered): the
          // structure's items are the evidence, and an element the draft re-created replaced the old one.
          this.chars(acc, db, 0, this.text(0, bb).text, this.text(1, db).text);
          const element = this.blocks.items[db];
          this.subtree(acc, element, false);
          if (this.origin(element.id.client, element.id.clock) !== BASE) removed++;
          continue;
        }
        this.blockRule(acc, db, B.toks[r[0]], D.toks[i[0]]);
        const [, bh] = this.widen(B, r[0] + 1, r[1], false, k === sr.length - 1);
        const [, dh] = this.widen(D, i[0] + 1, i[1], false, k === si.length - 1);
        const was = this.span(0, bb, r[0] + 1, bh);
        const now = this.span(1, db, i[0] + 1, dh);
        this.chars(acc, db, now.at, was.text, now.text);
        this.marks(
          acc,
          db,
          now.at,
          now.at + now.text.length,
          B.toks.slice(r[0] + 1, r[1]),
          D.toks.slice(i[0] + 1, i[1]),
        );
        continue;
      }
      if (r) removed++;
      if (i) {
        const db = D.blockOf[i[0]];
        const item = this.blocks.items[db];
        this.evidence(acc, item);
        if (iAtom) this.subtree(acc, item, true);
        else {
          const [, dh] = this.widen(D, i[0] + 1, i[1], false, false);
          const now = this.span(1, db, i[0] + 1, dh);
          this.chars(acc, db, now.at, "", now.text);
        }
      }
    }
    if (removed) {
      const gap = (q: number) =>
        q >= D.toks.length
          ? this.blocks.items.length
          : isBlockTok(D.toks[q])
            ? D.blockOf[q]
            : D.blockOf[q] + 1;
      const points: Y.Item[][] = [];
      for (let g = gap(q0); g <= gap(q1); g++) points.push(this.blocks.gaps[g] ?? []);
      this.red(acc, points, removed);
    }
  }

  /** A paired block whose type or attributes changed: the items that made the change are the evidence. */
  private blockRule(acc: Acc, db: number, was: Tok, now: Tok) {
    if (was.kind !== "block" || now.kind !== "block" || was.key === now.key) return;
    const item = this.blocks.items[db];
    // A type change re-creates the element: its own origin is the evidence.
    if (this.origin(item.id.client, item.id.clock) !== BASE) return this.evidence(acc, item);
    const a = was.node.attrs as Record<string, unknown>;
    const b = now.node.attrs as Record<string, unknown>;
    const type = (item.content as Y.ContentType).type;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
      const attr = type._map.get(key);
      if (!attr) continue;
      if (attr.deleted) this.removed(acc, attr);
      else this.evidence(acc, attr);
    }
  }

  classify(): Map<string, ChangeClassification> {
    const out = new Map<string, ChangeClassification>();
    for (const group of this.projection.groups) {
      const acc: Acc = { names: new Map(), members: new Set(), base: [], settled: [] };
      for (const h of group.hunks)
        for (const piece of this.pieces(this.projection.diff.hunks[h.index])) this.hunk(acc, piece);
      const byline: Author[] = [];
      if (acc.names.has("user")) byline.push({ kind: "user", userId: this.provenance.userId });
      for (const who of [...acc.names.values()].filter((w) => w >= 0).sort((x, y) => x - y)) {
        const { threadId, turnId, toolCallId } = this.parts[who];
        byline.push({ kind: "thread", threadId, turnId, ...(toolCallId ? { toolCallId } : {}) });
      }
      out.set(group.id, {
        byline,
        members: [...acc.members].sort((x, y) => x - y),
        ...(this.options.record
          ? { applied: { base: joined(acc.base), settled: joined(acc.settled) } }
          : {}),
      });
    }
    return out;
  }
}

/** One side's block text: tokens joined (an atom block reads its node's text) with each token's offset. */
class SideText {
  readonly atom: boolean;
  readonly text: string;
  readonly offsets: Int32Array;
  constructor(side: Side, b: number) {
    const lo = side.starts[b];
    const hi = side.starts[b + 1];
    this.atom = side.toks[lo]?.kind === "atom";
    this.offsets = new Int32Array(hi - lo + 1);
    let text = "";
    for (let i = lo; i < hi; i++) {
      this.offsets[i - lo] = text.length;
      text += tokStr(side.toks[i]);
    }
    this.offsets[hi - lo] = text.length;
    this.text = this.atom ? (side.blocks[b].textContent as string) : text;
  }
}

/** Per change id: who wrote it and which AI parts are in it. Silent (empty byline) under doubt. */
export function classifyChanges(
  doc: Y.Doc,
  projection: ReviewProjection,
  provenance: Provenance,
  options: ClassifyOptions = {},
): Map<string, ChangeClassification> {
  const classifier = new Classifier(doc, projection, provenance, options);
  // A fragment that moved on since the projection was computed no longer lines up block for block.
  return classifier.aligned ? classifier.classify() : new Map();
}

/** The Apply record for the changes `ids`, from a classification made with `record: true`. */
export function applyRecordOf(
  classified: ReadonlyMap<string, ChangeClassification>,
  ids: Iterable<string>,
): ApplyEntry {
  const entry: ApplyEntry = { base: [], settled: [] };
  for (const id of ids) {
    entry.base.push(...(classified.get(id)?.applied?.base ?? []));
    entry.settled.push(...(classified.get(id)?.applied?.settled ?? []));
  }
  return entry;
}
