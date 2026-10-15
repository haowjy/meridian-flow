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
import type { RestorationLink } from "./restorations.js";
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
  /** Links the server computed from tombstone text, plus the browser's own for its undo stacks. */
  restorations?: readonly RestorationLink[];
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
}

const DIFF_BUDGET = 64_000;
const SLIDE_CAP = 256;
/** Alignment work (alignments times characters) one op may cost before it is left unnamed. */
const SLIDE_WORK = 200_000;
const LINK_HOPS = 32;
const OBJECT = "￼";
const BASE = -1;
const USER = -2;

const tokStr = (t: Tok) => (t.kind === "text" ? t.ws + t.core : t.kind === "inline" ? OBJECT : "");

/** A block's content laid out by character offset. */
interface BlockIx {
  units: Array<{ at: number; item: Y.Item }>;
  dead: Array<{ at: number; item: Y.Item }>;
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
      if (c.content instanceof Y.ContentFormat) {
        if (!c.deleted) ix.formats.push({ at: pos, item: c });
      } else if (c.deleted) ix.dead.push({ at: pos, item: c });
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

/** Every offset an insert of `n` characters at `start` could sit at, by sliding over equal characters. */
function slideInsert(text: string, start: number, n: number): number[] {
  let lo = start;
  let hi = start;
  for (let i = 0; i < SLIDE_CAP && lo > 0 && text[lo - 1] === text[lo + n - 1]; i++) lo--;
  for (let i = 0; i < SLIDE_CAP && hi + n < text.length && text[hi] === text[hi + n]; i++) hi++;
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** Every offset a deletion of `removed` at `p` could sit at. */
function slideDelete(text: string, p: number, removed: string): number[] {
  const points = [p];
  let r = removed;
  let lo = p;
  for (let i = 0; i < SLIDE_CAP && lo > 0 && text[lo - 1] === r[r.length - 1]; i++) {
    r = r[r.length - 1] + r.slice(0, -1);
    points.push(--lo);
  }
  r = removed;
  let hi = p;
  for (let i = 0; i < SLIDE_CAP && hi < text.length && text[hi] === r[0]; i++) {
    r = r.slice(1) + r[0];
    points.push(++hi);
  }
  return points;
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

const pushRange = (out: ItemRange[], client: number, clock: number, len = 1) => {
  const last = out[out.length - 1];
  if (last && last[0] === client && last[1] + last[2] === clock)
    out[out.length - 1] = [client, last[1], last[2] + len];
  else out.push([client, clock, len]);
};

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
  private readonly blocks: { items: Y.Item[]; gaps: Y.Item[][] };
  private readonly indexes = new Map<number, BlockIx>();
  private readonly texts = [new Map<number, SideText>(), new Map<number, SideText>()] as const;

  constructor(
    doc: Y.Doc,
    private readonly projection: ReviewProjection,
    private readonly provenance: Provenance,
    private readonly options: ClassifyOptions,
  ) {
    this.parts = provenance.parts;
    this.budget = options.budget ?? DIFF_BUDGET;
    this.inserted = indexRanges(this.parts.map((p) => p.inserted));
    this.deleted = indexRanges(this.parts.map((p) => p.deleted));
    const record = readApplyRecord(doc);
    this.applied = indexRanges([record.flatMap((e) => e.base)]);
    this.settled = indexRanges([record.flatMap((e) => e.settled)]);
    this.linkList = provenance.restorations ?? [];
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

  /** `BASE`, `USER`, or the index of the AI part that wrote the character. */
  private origin(client: number, clock: number, hops = 0): number {
    if (this.applied.get(client, clock) >= 0) return BASE;
    const part = this.inserted.get(client, clock);
    if (part >= 0) return part;
    if (client === DRAFT_SERVER_CLIENT_ID) return BASE;
    const to = hops < LINK_HOPS ? this.link(client, clock) : null;
    return to ? this.origin(to[0], to[1], hops + 1) : USER;
  }

  /** The AI part that deleted the tombstone character, else the user. */
  private deleter(client: number, clock: number, hops = 0): number {
    const part = this.deleted.get(client, clock);
    if (part >= 0) return part;
    const to = hops < LINK_HOPS ? this.link(client, clock) : null;
    return to ? this.deleter(to[0], to[1], hops + 1) : USER;
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

  // ---- evidence ----

  private evidence(acc: Acc, client: number, clock: number, len = 1) {
    for (let k = 0; k < len; k++) {
      const who = this.origin(client, clock + k);
      if (who === BASE) continue;
      this.name(acc, who);
      if (this.options.record) pushRange(acc.base, client, clock + k);
    }
  }

  /** The members of a span nobody could classify: AI parts among its items and the tombstones in it. */
  private spanMembers(acc: Acc, b: number, from: number, to: number) {
    const ix = this.index(b);
    this.eachChar(ix, from, to, (c, k) => {
      const who = this.origin(c, k);
      if (who >= 0) acc.members.add(who);
    });
    for (let i = lowerBound(ix.dead, from); i < ix.dead.length && ix.dead[i].at <= to; i++) {
      const { item } = ix.dead[i];
      for (let k = 0; k < item.length; k++) {
        const part = this.deleted.get(item.id.client, item.id.clock + k);
        if (part >= 0 && this.settled.get(item.id.client, item.id.clock + k) < 0)
          acc.members.add(part);
      }
    }
  }

  /** Green: `n` characters at `start` of draft block `b` are new. */
  private green(acc: Acc, b: number, start: number, n: number) {
    const ix = this.index(b);
    const points = ix.bad ? [] : slideInsert(ix.text, start, n);
    if (ix.bad || points.length * n > SLIDE_WORK) return this.spanMembers(acc, b, start, start + n);
    const all = points.map((p) => {
      const origins = new Set<number>();
      this.eachChar(ix, p, p + n, (c, k) => origins.add(this.origin(c, k)));
      return origins;
    });
    for (const origins of all) for (const who of origins) if (who >= 0) acc.members.add(who);
    // An alignment that lands on base text cannot be the insert: the base contained that text already.
    const valid = all.filter((o) => !o.has(BASE));
    this.nameCommon(
      acc,
      (valid.length ? valid : all).map((o) => this.keyed([...o].filter((w) => w !== BASE))),
    );
    if (this.options.record)
      for (const p of points)
        this.eachChar(ix, p, p + n, (c, k) => {
          if (this.origin(c, k) !== BASE) pushRange(acc.base, c, k);
        });
  }

  /** Red: `weight` characters (or blocks) were removed; `points` are the tombstone lists where they may sit. */
  private red(acc: Acc, points: Array<readonly Y.Item[]>, weight: number) {
    const valid: Array<Map<string, number>> = [];
    for (const tombs of points) {
      const deleters: number[] = [];
      for (const item of tombs)
        for (let k = 0; k < item.length; k++) {
          const c = item.id.client;
          const clock = item.id.clock + k;
          if (this.settled.get(c, clock) >= 0) continue;
          if (this.options.record) pushRange(acc.settled, c, clock);
          const part = this.deleted.get(c, clock);
          if (part >= 0) acc.members.add(part);
          if (this.origin(c, clock) === BASE && this.superseded.get(c, clock) < 0)
            deleters.push(this.deleter(c, clock));
        }
      if (deleters.length === weight) valid.push(this.keyed(deleters));
    }
    this.nameCommon(acc, valid);
  }

  /** Authors by key, each at its latest part (the lowest index); the user sorts first. */
  private keyed(who: number[]): Map<string, number> {
    const out = new Map<string, number>();
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

  // ---- the character edit ----

  private diff(a: string, b: string): Array<[number, string]> | null {
    const cost = a.length + b.length;
    if (cost > this.budget) return null;
    this.budget -= cost;
    return makeDiff(a, b, DIFF_OPTS) as Array<[number, string]>;
  }

  /** The character edit of one span, `draft` starting at offset `ds` of draft block `b`. */
  private chars(acc: Acc, b: number, ds: number, base: string, draft: string) {
    const ops = this.diff(base, draft);
    if (!ops) return this.spanMembers(acc, b, ds, ds + draft.length);
    const ix = this.index(b);
    let at = 0;
    ops.forEach(([op, txt], k) => {
      if (op === DIFF_INSERT) {
        this.green(acc, b, ds + at, txt.length);
        at += txt.length;
      } else if (op === DIFF_DELETE) {
        const starts = [at];
        if (ops[k + 1]?.[0] === DIFF_INSERT) starts.push(at + ops[k + 1][1].length);
        if (ops[k - 1]?.[0] === DIFF_INSERT) starts.push(at - ops[k - 1][1].length);
        const offsets = new Set(
          starts.flatMap((s) => (ix.bad ? [ds + s] : slideDelete(ix.text, ds + s, txt))),
        );
        this.red(
          acc,
          [...offsets].map((p) => this.deadAt(b, p)),
          txt.length,
        );
      } else if (op === DIFF_EQUAL) at += txt.length;
    });
  }

  /** The mark rule: a hunk that only changed marks is evidenced by the format items it changed. */
  private marks(
    acc: Acc,
    b: number,
    ds: number,
    de: number,
    rem: readonly Tok[],
    ins: readonly Tok[],
  ) {
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
    const { formats } = this.index(b);
    for (let i = lowerBound(formats, ds); i < formats.length && formats[i].at <= de; i++) {
      const { item } = formats[i];
      const key = (item.content as Y.ContentFormat).key;
      if ([...changed].some((n) => key === n || key.startsWith(`${n}--`)))
        this.evidence(acc, item.id.client, item.id.clock);
    }
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
          this.chars(acc, db, 0, this.text(0, bb).text, this.text(1, db).text);
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
        this.evidence(acc, item.id.client, item.id.clock);
        if (!iAtom) {
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
    if (this.origin(item.id.client, item.id.clock) !== BASE)
      return this.evidence(acc, item.id.client, item.id.clock);
    const a = was.node.attrs as Record<string, unknown>;
    const b = now.node.attrs as Record<string, unknown>;
    const type = (item.content as Y.ContentType).type;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
      const attr = type._map.get(key);
      if (attr && !attr.deleted) this.evidence(acc, attr.id.client, attr.id.clock);
    }
  }

  classify(): Map<string, ChangeClassification> {
    const out = new Map<string, ChangeClassification>();
    for (const group of this.projection.groups) {
      const acc: Acc = { names: new Map(), members: new Set(), base: [], settled: [] };
      for (const h of group.hunks) this.hunk(acc, this.projection.diff.hunks[h.index]);
      const byline: Author[] = [];
      if (acc.names.has("user")) byline.push({ kind: "user", userId: this.provenance.userId });
      for (const who of [...acc.names.values()].filter((w) => w >= 0).sort((x, y) => x - y)) {
        const { threadId, turnId, toolCallId } = this.parts[who];
        byline.push({ kind: "thread", threadId, turnId, ...(toolCallId ? { toolCallId } : {}) });
      }
      out.set(group.id, {
        byline,
        members: [...acc.members].sort((x, y) => x - y),
        ...(this.options.record ? { applied: { base: acc.base, settled: acc.settled } } : {}),
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
