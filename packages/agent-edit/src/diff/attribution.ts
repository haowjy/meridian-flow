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
 * slide). The footprint uses raw word/structural boundaries; only names use character edits. It reads
 * only lengths, ids and restoration links, so a browser (gc on) and the server (gc off) agree.
 */

import type { Author } from "@meridian/contracts/drafts";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import { type ApplyEntry, readApplyRecord } from "./apply-record.js";
import { DRAFT_SERVER_CLIENT_ID } from "./draft-base.js";
import type { Hunk } from "./hunks.js";
import { IdIndex, type ItemRange, indexRanges } from "./id-index.js";
import { type RestorationLink, readRestorations } from "./restorations.js";
import type { ReviewProjection } from "./review.js";
import { isBlockTok, type Side, type Tok, textDiff } from "./tokens.js";

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
  /** The room revision whose AI parts have been read, including deletion-only writes. */
  snapshot: Y.Snapshot;
  /** Only this browser can positively identify its own unacknowledged insertions. */
  localClientId?: number;
  /** Deletions this browser witnessed in its own local transactions. */
  localDeletions?: Y.Snapshot["ds"];
}
export interface ChangeClassification {
  /** The user first, then each writing thread once (linking to its latest write). */
  byline: Author[];
  /** Indexes of `parts` that are in the change under any alignment. */
  members: number[];
  /** Some footprint evidence lies beyond the provenance read. */
  unresolved: boolean;
  /** Unclassified item identities, independent of unrelated local edits. */
  unresolvedItems: ItemRange[];
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

// Cache only pure character scripts, never Yjs evidence or names. A retained node can acquire
// different spans after neighbouring edits; bound its entries, and retire them when the base changes.
const characterDiffs = new WeakMap<
  readonly PMNode[],
  WeakMap<PMNode, { size: number; spans: Map<string, Array<[number, string]>> }>
>();

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

/** Equal boundary whitespace is context, not part of a replaced word. */
function replacement(now: string, was: string) {
  let head = 0;
  let tail = 0;
  while (head < now.length && head < was.length && /\s/u.test(now[head]) && now[head] === was[head])
    head++;
  while (
    tail < now.length - head &&
    tail < was.length - head &&
    /\s/u.test(now[now.length - 1 - tail]) &&
    now[now.length - 1 - tail] === was[was.length - 1 - tail]
  )
    tail++;
  return {
    head,
    added: now.slice(head, now.length - tail),
    removed: was.slice(head, was.length - tail),
  };
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
interface Footprint {
  members: Set<number>;
  unresolvedItems: ItemRange[];
  unresolved: boolean;
  base: ItemRange[];
  settled: ItemRange[];
}

/** Phase 2 cannot mutate the footprint. Any unfinished precision work silences the byline. */
interface Names {
  names: Map<string, number>;
  incomplete: boolean;
}

/** Raw projection boundaries, shared by footprint collection and name refinement. */
interface Boundaries {
  text(
    b: number,
    raw: { at: number; text: string },
    was: string,
    wide: { at: number; text: string },
    before: string,
  ): void;
  items(items: readonly Y.Item[], name?: boolean): void;
  subtree(item: Y.Item): void;
  removed(points: Array<readonly Y.Item[]>, weight: number): void;
}

type Boundary = {
  [K in keyof Boundaries]: { kind: K; args: Parameters<Boundaries[K]> };
}[keyof Boundaries];

function visit(boundary: Boundary, rules: Boundaries) {
  switch (boundary.kind) {
    case "text":
      return rules.text(...boundary.args);
    case "items":
      return rules.items(...boundary.args);
    case "subtree":
      return rules.subtree(...boundary.args);
    case "removed":
      return rules.removed(...boundary.args);
  }
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
  private readonly writeBack: IdIndex;
  private readonly undone: IdIndex;
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
  private readonly writeBackMemo = new IdMemo();

  constructor(
    doc: Y.Doc,
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
    const restored = readRestorations(doc);
    this.writeBack = indexRanges([restored.base]);
    this.undone = indexRanges([restored.undone]);
    this.linkList = restored.links;
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
    unlinked: (client: number, clock: number) => number,
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
        who = unlinked(c, k);
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
        // A restoration link takes precedence over a write-back record: Undo keeps its source.
        if (this.links.get(c, k) < 0 && this.writeBack.get(c, k) >= 0) return BASE;
        const part = this.inserted.get(c, k);
        if (part >= 0) return part;
        return c === DRAFT_SERVER_CLIENT_ID ? BASE : undefined;
      },
      (c, k) =>
        c === this.provenance.localClientId || k < (this.provenance.snapshot.sv.get(c) ?? 0)
          ? USER
          : UNKNOWN,
    );
  }

  /** A Discard copy (including Redo copies), unless Apply has since made it real base. */
  private isWriteBack(client: number, clock: number): boolean {
    return (
      this.chase(
        client,
        clock,
        this.writeBackMemo,
        (c, k) => {
          if (this.applied.get(c, k) >= 0) return 0;
          if (this.links.get(c, k) < 0 && this.writeBack.get(c, k) >= 0) return 1;
          return undefined;
        },
        () => 0,
      ) === 1
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
      (c, k) =>
        Y.isDeleted(this.provenance.snapshot.ds, Y.createID(c, k)) ||
        (this.provenance.localDeletions &&
          Y.isDeleted(this.provenance.localDeletions, Y.createID(c, k)))
          ? USER
          : UNKNOWN,
    );
  }

  private keyOf = (who: number) => (who === USER ? "user" : `thread:${this.parts[who].threadId}`);

  private name(acc: Names, who: number) {
    const key = this.keyOf(who);
    const seen = acc.names.get(key);
    acc.names.set(key, seen === undefined ? who : Math.min(seen, who));
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
    fn: (client: number, clock: number) => void,
  ) {
    let u = lowerBound(ix.units, from + 1) - 1;
    for (let pos = from; pos < to; ) {
      while (u + 1 < ix.units.length && ix.units[u + 1].at <= pos) u++;
      const unit = ix.units[u];
      if (!unit) return;
      const end = Math.min(to, unit.at + unit.item.length);
      for (; pos < end; pos++) fn(unit.item.id.client, unit.item.id.clock + (pos - unit.at));
    }
  }

  /** Phase 1: collect the complete footprint before any bounded name work. */
  private footprint(changes: readonly Boundary[]): Footprint {
    const footprint: Footprint = {
      members: new Set(),
      unresolved: false,
      unresolvedItems: [],
      base: [],
      settled: [],
    };
    const include = (who: number) => {
      if (who >= 0) footprint.members.add(who);
      if (who === UNKNOWN) footprint.unresolved = true;
    };
    const live = (client: number, clock: number) => {
      const who = this.origin(client, clock);
      if (who === BASE) return;
      include(who);
      if (who === UNKNOWN) pushRange(footprint.unresolvedItems, client, clock);
      if (this.options.record) pushRange(footprint.base, client, clock);
    };
    const dead = (item: Y.Item) => {
      for (let k = 0; k < item.length; k++) {
        const c = item.id.client;
        const clock = item.id.clock + k;
        if (this.settled.get(c, clock) >= 0) continue;
        if (this.options.record) pushRange(footprint.settled, c, clock);
        const who = this.deleter(c, clock);
        include(who);
        if (who === UNKNOWN) pushRange(footprint.unresolvedItems, c, clock);
      }
    };
    const item = (value: Y.Item) => {
      if (value.deleted) dead(value);
      else for (let k = 0; k < value.length; k++) live(value.id.client, value.id.clock + k);
    };
    const subtree = (value: Y.Item) => {
      item(value);
      // A deleted container's children are GC'd on peers. Its own item represents the removal.
      if (value.deleted || !(value.content instanceof Y.ContentType)) return;
      for (const attr of value.content.type._map.values()) item(attr);
      for (let child = value.content.type._start; child; child = child.right) subtree(child);
    };
    const boundaries: Boundaries = {
      text: (b, now, was) => {
        const ix = this.index(b);
        let lo = now.at;
        let hi = lo + now.text.length;
        // Scan the whole slide envelope once, not once per candidate alignment. No precision cap
        // may choose which items Apply accepts, even when Phase 2 never runs.
        const { head, added, removed } = replacement(now.text, was);
        const start = now.at + head;
        if (!ix.bad && added.length) {
          const slide = slideInsert(ix.text, start, added.length, Infinity);
          lo = Math.min(lo, slide.lo);
          hi = Math.max(hi, slide.hi + added.length);
        }
        if (!ix.bad && removed.length) {
          for (const at of [start, start + added.length]) {
            const slide = slideDelete(ix.text, at, removed, Infinity);
            lo = Math.min(lo, slide.lo);
            hi = Math.max(hi, slide.hi);
          }
        }
        if (ix.bad) {
          // A payload can arrive before the editor's debounced projection catches up. Its old
          // offsets no longer address this block: retain the block's footprint, but name nobody.
          const last = ix.units.at(-1);
          lo = 0;
          hi = last ? last.at + last.item.length : 0;
        }
        this.eachChar(ix, lo, hi, live);
        for (let i = lowerBound(ix.dead, lo); i < ix.dead.length && ix.dead[i].at <= hi; i++)
          dead(ix.dead[i].item);
      },
      items: (items) => {
        for (const current of items) {
          item(current);
          // Attribute overwrites form a left chain; changed keys own its deleted items too.
          if (current.parentSub !== null)
            for (let previous = current.left; previous; previous = previous.left) item(previous);
        }
      },
      subtree,
      removed: (points) => {
        for (const items of points) for (const item of items) dead(item);
      },
    };
    for (const change of changes) visit(change, boundaries);
    if (footprint.unresolved) for (let i = 0; i < this.parts.length; i++) footprint.members.add(i);
    return footprint;
  }

  /** Phase 2: optional precision. Its only writable output is the byline. */
  private names(changes: readonly Boundary[]): Names {
    const acc: Names = { names: new Map(), incomplete: false };
    const boundaries: Boundaries = {
      text: (b, raw, was, now, before) => {
        const deleted = this.chars(acc, b, now.at, before, now.text);
        if (acc.incomplete || !deleted) return;
        const { head, added, removed } = replacement(raw.text, was);
        if (!added || !removed || added === removed) return;
        const start = raw.at + head;
        let replaced = true;
        this.eachChar(this.index(b), start, start + added.length, (c, k) => {
          const who = this.origin(c, k);
          if (who === BASE || who === UNKNOWN) replaced = false;
        });
        // Equal letters in recreated words are not retained base anchors: sword → sabre shares
        // s/r, but its five base tombstones can still prove who made a visible deletion.
        // Red must allow for the equal characters, not credit every historical remover.
        if (replaced) this.deletion(acc, b, [start, start + added.length], removed, deleted);
      },
      items: (items, name = true) => {
        if (!name) return;
        for (const item of items) {
          const who = item.deleted
            ? this.deleter(item.id.client, item.id.clock)
            : this.origin(item.id.client, item.id.clock);
          if (who !== BASE && !isUnknown(who) && (!item.deleted || who >= 0)) this.name(acc, who);
        }
      },
      subtree: () => {},
      removed: (points, weight) => this.red(acc, points, weight),
    };
    for (const change of changes) {
      visit(change, boundaries);
      if (acc.incomplete) break;
    }
    if (acc.incomplete) acc.names.clear();
    return acc;
  }

  /** Green: `n` characters at `start` of draft block `b` are new. */
  private green(acc: Names, b: number, start: number, n: number) {
    const ix = this.index(b);
    if (ix.bad) {
      acc.incomplete = true;
      return;
    }
    const { lo, hi, cut } = slideInsert(ix.text, start, n, this.slide);
    if (cut || (hi - lo + 1) * n > SLIDE_WORK) {
      acc.incomplete = true;
      return;
    }
    const all: Array<Set<number>> = [];
    for (let p = lo; p <= hi; p++) {
      const origins = new Set<number>();
      this.eachChar(ix, p, p + n, (c, k) => {
        const who = this.origin(c, k);
        origins.add(who);
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

  /** Red: exact `weight` tombstones must account for a visible deletion of `deleted` characters or blocks. */
  private red(acc: Names, points: Array<readonly Y.Item[]>, weight: number, deleted = weight) {
    const valid: Array<Map<string, number>> = [];
    for (const tombs of points) {
      const deleters: number[] = [];
      for (const item of tombs)
        for (let k = 0; k < item.length; k++) {
          const c = item.id.client;
          const clock = item.id.clock + k;
          if (
            this.settled.get(c, clock) < 0 &&
            !(this.undone.get(c, clock) >= 0 && this.isWriteBack(c, clock)) &&
            this.origin(c, clock) === BASE &&
            this.superseded.get(c, clock) < 0
          )
            deleters.push(this.deleter(c, clock));
        }
      if (deleters.length === weight) {
        const names = this.keyed(deleters);
        // Whole-word evidence may include equal letters. A remover is certain only if their
        // characters cannot all fit outside this visible deletion, regardless of alignment.
        if (deleted < weight) {
          const counts = new Map<string, number>();
          for (const who of deleters) {
            if (isUnknown(who)) continue;
            const key = this.keyOf(who);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          for (const key of names.keys())
            if ((counts.get(key) ?? 0) <= weight - deleted) names.delete(key);
        }
        valid.push(names);
      }
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
  private nameCommon(acc: Names, alignments: Array<Map<string, number>>) {
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

  /** Locate exact tombstones for `removed`; whole-word evidence may support a smaller visible deletion. */
  private deletion(
    acc: Names,
    b: number,
    starts: number[],
    removed: string,
    deleted = removed.length,
  ) {
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
    const points = new Set<number>();
    if (!cut) for (const [x, y] of spans) for (let p = x; p <= y; p++) points.add(p);
    if (cut || points.size * removed.length > SLIDE_WORK) {
      acc.incomplete = true;
      return;
    }
    this.red(
      acc,
      [...points].map((p) => this.deadAt(b, p)),
      removed.length,
      deleted,
    );
  }

  // ---- the character edit ----

  /**
   * The character edit between two spans. What the two share at both ends is trimmed first, so a one-word
   * edit never reaches diff-match-patch, and only what is left counts against the budget.
   */
  private diff(block: number, a: string, b: string): Array<[number, string]> | null {
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
    const { base, draft } = this.projection.diff;
    let byNode = characterDiffs.get(base.blocks);
    if (!byNode) {
      byNode = new WeakMap();
      characterDiffs.set(base.blocks, byNode);
    }
    const node = draft.blocks[block];
    let cached = byNode.get(node);
    if (!cached) {
      cached = { size: 0, spans: new Map() };
      byNode.set(node, cached);
    }
    const key = JSON.stringify([was, now]);
    // Charge the same budget on hits: cache warmth must not change which bylines can be named.
    let middle = cached.spans.get(key);
    if (!middle) {
      middle =
        !was || !now || (was.length === 1 && now.length === 1)
          ? [
              ...(was ? [[DIFF_DELETE, was] as [number, string]] : []),
              ...(now ? [[DIFF_INSERT, now] as [number, string]] : []),
            ]
          : textDiff(was, now);
      if (cached.size + cost > DIFF_BUDGET) {
        cached.spans.clear();
        cached.size = 0;
      }
      cached.size += cost;
      cached.spans.set(key, middle);
    }
    return [
      ...(lo ? [[DIFF_EQUAL, a.slice(0, lo)] as [number, string]] : []),
      ...middle,
      ...(hi ? [[DIFF_EQUAL, a.slice(a.length - hi)] as [number, string]] : []),
    ];
  }

  /** Name a span's character edits and return its largest deletion's length for whole-word evidence. */
  private chars(acc: Names, b: number, ds: number, base: string, draft: string) {
    if (this.index(b).bad) {
      acc.incomplete = true;
      return;
    }
    const ops = this.diff(b, base, draft);
    if (!ops) {
      acc.incomplete = true;
      return;
    }
    let at = 0;
    let deleted = 0;
    ops.forEach(([op, txt], k) => {
      if (op === DIFF_INSERT) {
        this.green(acc, b, ds + at, txt.length);
        at += txt.length;
      } else if (op === DIFF_DELETE) {
        deleted = Math.max(deleted, txt.length);
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
        at += txt.length;
      }
    });
    return deleted;
  }

  /** The mark rule: a hunk that only changed marks is evidenced by the format items it changed or removed. */
  private marks(b: number, ds: number, de: number, rem: readonly Tok[], ins: readonly Tok[]) {
    const items: Y.Item[] = [];
    if (!rem.some(marked) && !ins.some(marked)) return items;
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
    if (!was.size && !now.size) return items;
    const changed = new Set(
      [...was, ...now].filter(([k]) => !(was.has(k) && now.has(k))).map(([, n]) => n),
    );
    if (!changed.size) return items;
    const { formats } = this.index(b);
    for (let i = lowerBound(formats, ds); i < formats.length && formats[i].at <= de; i++) {
      const { item } = formats[i];
      const key = (item.content as Y.ContentFormat).key;
      if ([...changed].some((n) => key === n || key.startsWith(`${n}--`))) items.push(item);
    }
    // Deleted formats lose their content kind under GC. Include dead units consistently; they
    // belong to the footprint but cannot name an exact removed mark.
    return items;
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

  /** Leading whitespace is carried by the next token, but a changed word owns its trailing
   * separator too. Include that edge, never the unchanged next word. */
  private rawSpan(side: 0 | 1, b: number, lo: number, hi: number) {
    const span = this.span(side, b, lo, hi);
    const next = (side ? this.projection.diff.draft : this.projection.diff.base).toks[hi];
    return { ...span, text: span.text + (next?.kind === "text" ? next.ws : "") };
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

  private hunk(boundaries: Boundaries, h: Hunk) {
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
        const raw = this.rawSpan(1, db, i[0], i[1]);
        boundaries.text(db, raw, this.rawSpan(0, bb, r[0], r[1]).text, now, was.text);
        boundaries.items(
          this.marks(
            db,
            raw.at,
            raw.at + raw.text.length,
            B.toks.slice(r[0], r[1]),
            D.toks.slice(i[0], i[1]),
          ),
          r[0] < r[1] && i[0] < i[1],
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
          const now = { at: 0, text: this.text(1, db).text };
          const was = this.text(0, bb).text;
          boundaries.text(db, now, was, now, was);
          const element = this.blocks.items[db];
          boundaries.subtree(element);
          if (this.origin(element.id.client, element.id.clock) !== BASE) removed++;
          continue;
        }
        const changed = this.blockItems(db, B.toks[r[0]], D.toks[i[0]]);
        boundaries.items(changed);
        if (changed.includes(this.blocks.items[db])) boundaries.subtree(this.blocks.items[db]);
        const [, bh] = this.widen(B, r[0] + 1, r[1], false, k === sr.length - 1);
        const [, dh] = this.widen(D, i[0] + 1, i[1], false, k === si.length - 1);
        const was = this.span(0, bb, r[0] + 1, bh);
        const now = this.span(1, db, i[0] + 1, dh);
        const raw = this.rawSpan(1, db, i[0] + 1, i[1]);
        boundaries.text(db, raw, this.rawSpan(0, bb, r[0] + 1, r[1]).text, now, was.text);
        boundaries.items(
          this.marks(
            db,
            raw.at,
            raw.at + raw.text.length,
            B.toks.slice(r[0] + 1, r[1]),
            D.toks.slice(i[0] + 1, i[1]),
          ),
          r[0] + 1 < r[1] && i[0] + 1 < i[1],
        );
        continue;
      }
      if (r) removed++;
      if (i) {
        const db = D.blockOf[i[0]];
        const item = this.blocks.items[db];
        boundaries.items([item]);
        boundaries.subtree(item);
        if (!iAtom) {
          const [, dh] = this.widen(D, i[0] + 1, i[1], false, false);
          const now = this.span(1, db, i[0] + 1, dh);
          boundaries.text(db, now, "", now, "");
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
      boundaries.removed(points, removed);
    }
  }

  /** A paired block whose type or attributes changed: the items that made the change are the evidence. */
  private blockItems(db: number, was: Tok, now: Tok): Y.Item[] {
    if (was.kind !== "block" || now.kind !== "block" || was.key === now.key) return [];
    const item = this.blocks.items[db];
    if (this.origin(item.id.client, item.id.clock) !== BASE) return [item];
    const a = was.node.attrs as Record<string, unknown>;
    const b = now.node.attrs as Record<string, unknown>;
    const type = (item.content as Y.ContentType).type;
    const items: Y.Item[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
      const attr = type._map.get(key);
      if (attr) items.push(attr);
    }
    return items;
  }

  classify(): Map<string, ChangeClassification> {
    const out = new Map<string, ChangeClassification>();
    for (const group of this.projection.groups) {
      const hunks = group.hunks.flatMap((h) => this.pieces(this.projection.diff.hunks[h.index]));
      const changes: Boundary[] = [];
      const boundaries: Boundaries = {
        text: (...args) => {
          changes.push({ kind: "text", args });
        },
        items: (...args) => {
          changes.push({ kind: "items", args });
        },
        subtree: (...args) => {
          changes.push({ kind: "subtree", args });
        },
        removed: (...args) => {
          changes.push({ kind: "removed", args });
        },
      };
      for (const hunk of hunks) this.hunk(boundaries, hunk);
      const footprint = this.footprint(changes);
      const acc = this.names(changes);
      const byline: Author[] = [];
      if (acc.names.has("user")) byline.push({ kind: "user", userId: this.provenance.userId });
      for (const who of [...acc.names.values()].filter((w) => w >= 0).sort((x, y) => x - y)) {
        const { threadId, turnId, toolCallId } = this.parts[who];
        byline.push({ kind: "thread", threadId, turnId, ...(toolCallId ? { toolCallId } : {}) });
      }
      out.set(group.id, {
        byline,
        unresolved: footprint.unresolved,
        unresolvedItems: joined(footprint.unresolvedItems),
        members: [...footprint.members].sort((x, y) => x - y),
        ...(this.options.record
          ? { applied: { base: joined(footprint.base), settled: joined(footprint.settled) } }
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
