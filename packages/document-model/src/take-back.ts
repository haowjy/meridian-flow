import type { Change, Delta, Frontiers, LoroDoc, LoroText, PeerID } from "loro-crdt";
import {
  type CommitAuthor,
  type OpSpans,
  readCommitMessage,
  type StandsFor,
  type TakeBackNote,
} from "./commit-message.js";
import { inMap, inText } from "./handles.js";
import type { RoomDocs } from "./room-docs.js";
import {
  type BlockId,
  type DocKey,
  membersOf,
  overrideMap,
  type StructureMap,
  sameValue,
} from "./shape.js";
import { isOrderKey, removalOf, StructureView, showRule } from "./structure.js";
import { type DocVersion, docVersion, plainVersion } from "./version.js";
import { commitStructure, type DocChange, StructureWriter } from "./write.js";

/**
 * The rule every Undo follows (design §2, "An Undo takes an edit back whole, or leaves it whole"):
 * an edit (a Ctrl+Z step, or one change of a press) goes back only while nobody else has written
 * over it, and then goes back whole. The editor's `UndoHistory` tests its steps with it, and a
 * press's Undo each change (`undoPress`). Nothing here knows how the edit's text is taken back
 * (Loro's `UndoManager` in the editor, an inverse on the server, `invert.ts`).
 */

/**
 * A structure value an edit set: what the key held before the edit, and what the edit left. In a
 * draft, an override the edit left absent reads Live's value through it: `base` is that value.
 */
export interface SetValue {
  before: unknown;
  left: unknown;
  base?: unknown;
}

/** An edit's structure values, by stored map name (`order`, a draft's `d.order`) then key. */
export type EditValues = Map<string, Map<string, SetValue>>;

/**
 * What an edit, or its last run, wrote in one text doc: the frontiers either side, and its ops
 * there (`opsBetween`). In the editor those are the author's between the frontiers, a peer's
 * batch imported meanwhile left out; a press imports its draft's ops, every peer's between them.
 */
export interface TextSpan {
  before: Frontiers;
  after: Frontiers;
  ops: OpSpans;
}

/**
 * What the rule needs of an edit. `noteEdit` fills `leaving`, `arriving`, `shown` and `structureAt`
 * after each write or run, before the copy imports anything.
 */
export interface Edit {
  /**
   * Who wrote it: every write by another peer is "someone else's". Not the copy's peer: a press's
   * Undo runs on a server copy with a peer of its own.
   */
  peer: PeerID;
  values: EditValues;
  texts: Map<DocKey, TextSpan>;
  /**
   * The blocks the edit's next run would take off the screen, each with the version of its text
   * it would take: what the removal it puts back read, or the text as it was when noted.
   */
  leaving: Map<BlockId, DocVersion>;
  /** The blocks its next run would bring onto the screen. */
  arriving: Set<BlockId>;
  /** The text docs it wrote whose blocks showed. */
  shown: Set<DocKey>;
  /** The structure doc's frontiers when noted: a peer's removal since may have taken its text. */
  structureAt: Frontiers;
  /**
   * Its text goes back through Loro's `UndoManager` (a tab's Ctrl+Z step), which deletes only the
   * characters the edit wrote: text another Undo put back for them, which a press's inverse
   * deletes too (`putBackOf`), counts as written over (part 4).
   */
  ownTextOnly?: boolean;
}

/**
 * Add to `into` the structure keys the commits from `before` to `after` set: for a key not in it
 * yet the value before them, and for every key the value they left. Called just after the commits,
 * so a draft override they left absent reads Live's value now (`SetValue.base`).
 */
export function valuesOf(
  doc: LoroDoc,
  before: Frontiers,
  after: Frontiers,
  into: EditValues = new Map(),
): EditValues {
  const old = new Map(doc.diff(after, before, true));
  for (const [container, diff] of doc.diff(before, after, true)) {
    if (diff.type !== "map") continue;
    const name = mapName(container);
    const was = old.get(container);
    const keys = keysOf(into, name);
    for (const [key, left] of Object.entries(diff.updated)) {
      const value = keys.get(key) ?? {
        before: was?.type === "map" ? was.updated[key] : undefined,
        left,
      };
      value.left = left;
      value.base = baseThrough(doc, name, key, left);
      keys.set(key, value);
    }
  }
  return into;
}

/** In a draft, Live's value an override `name[key]` that holds `left` reads through, if absent. */
function baseThrough(doc: LoroDoc, name: string, key: string, left: unknown): unknown {
  if (left !== undefined || !name.startsWith("d.")) return undefined;
  return inMap(doc, baseName(name), (map) => map.get(key));
}

/**
 * Note, after the edit was written or run, what its next run would take off the screen and bring
 * onto it, and which of its text docs show. A block leaves with its text as the removal record the
 * run puts back read it (typing that record did not read brought the block back, and must keep
 * it), or as it is now. An edit that set no structure takes nothing away. Nothing in the note
 * changes with this copy's own typing, so a caller may take it late, but before an import or a
 * write of its own that may set structure. `view`, if given, reads the docs as they are.
 */
export function noteEdit(docs: RoomDocs, edit: Edit, view?: StructureView): void {
  edit.structureAt = docs.structure.frontiers();
  edit.leaving.clear();
  edit.arriving.clear();
  edit.shown.clear();
  if (edit.values.size === 0) return;
  view ??= new StructureView(docs);
  const after = screenAfter(docs, view, edit.values);
  const order = edit.values.get(docs.draft ? overrideMap("order") : "order");
  const read = (id: BlockId): DocVersion | undefined => {
    for (let at: BlockId | null | undefined = id; typeof at === "string"; at = view.parent(at)) {
      const removal = removalOf(order?.get(at)?.before);
      if (removal) return removal.seen.get(id) ?? new Map();
    }
    const doc = docs.textOf(id);
    return doc && docVersion(doc);
  };
  for (const id of after.hidden) edit.leaving.set(id, read(id) ?? new Map());
  for (const id of after.arriving) edit.arriving.add(id);
  for (const key of edit.texts.keys()) if (view.shown.has(key)) edit.shown.add(key);
}

/**
 * Why `edit` must stay, or null when it can go back whole: every key it set holds a value its
 * author wrote last (1: a peer's removal can equal the edit's own, so not by value); every block
 * its run would take off the screen is one it would have taken when noted, with no one else's
 * write in its text since, and the blocks it would bring onto the screen the ones it would have
 * brought (2: a block a peer removed since, with what is under it, stays removed); every text doc
 * it wrote that showed still shows or leaves with it (3); all the text it put in is left (for
 * `Edit.ownTextOnly`, by id), and for an edit that set structure unrestyled; no style
 * it set was set again over the same text, and no text it deleted was taken away again, by a
 * delete or by a removal of its block that read it (4). "Written over" is by a peer other than
 * the author: the author's own untracked writes (an upload landing, a restore) never keep an edit.
 * `view`, if given, reads the docs as they are.
 */
export function editStays(docs: RoomDocs, edit: Edit, view?: StructureView): string | null {
  const { peer } = edit;
  for (const [name, keys] of edit.values) {
    const why = inMap(docs.structure, name, (map) => {
      for (const [key, { before, left, base }] of keys) {
        if (sameValue(before, left)) continue;
        if (map.getLastEditor(key) !== peer) return `${name}[${key}] was written over`;
        // An absent override reads Live's value: Live writing another one since writes over it.
        if (map.get(key) === undefined && name.startsWith("d.")) {
          const through = inMap(docs.structure, baseName(name), (live) =>
            sameValue(live.get(key), base) ? null : live.getLastEditor(key),
          );
          if (through && through !== peer) return `${baseName(name)}[${key}] was written over`;
        }
      }
      return null;
    });
    if (why) return why;
  }
  const structural = edit.values.size > 0;
  let removals: Map<DocKey, DocVersion[]> | undefined;
  for (const [key, { before, after, ops }] of edit.texts) {
    const doc = docs.textOf(key);
    if (!doc) continue;
    const then = plainVersion(doc.frontiersToVV(after));
    const deleted = deletedBy(doc, ops);
    if (deleted.size > 0) {
      removals ??= removalsSince(docs, edit.structureAt, peer);
      if (readAny(removals.get(key) ?? [], deleted, ops))
        return `text it deleted in ${key} left with a block another peer removed`;
    }
    if (!othersWrote(doc, then, peer)) continue;
    const again = deletedAgain(doc, before, after, deleted, peer);
    if (again) return `text it deleted in ${key} was ${again}`;
    // A write that kept some of the edit's characters reads them as its own: a chat's rewrite
    // keeps the letters it shares, and taking those out scrambles its words. An edit that set
    // structure moved text between blocks by copy, and its Undo brings the original back beside
    // the copy: a restyle of the copy keeps it, or the original comes back without the style.
    const left = leftOf(doc, before, after, structural, edit.ownTextOnly ?? false);
    if (left === "deleted") return `some of what it put into ${key} was deleted`;
    if (left === "restyled") return `a style it set in ${key} was set again`;
    if (left === "touched") return `some of what it put into ${key} was restyled`;
  }
  if (!structural) return null;
  const read = view ?? new StructureView(docs);
  const after = screenAfter(docs, read, edit.values);
  for (const id of after.hidden) {
    if (!edit.leaving.has(id)) return `it would take ${id} off the screen`;
    const doc = docs.textOf(id);
    if (doc && othersStand(doc, edit.leaving.get(id) ?? new Map(), peer, edit.texts.get(id)?.ops))
      return `${id}, which it would take away, was written in`;
  }
  // A block comes back only from under removals the edit itself put back: one a peer removed
  // since, with what is under it, stays removed; and every block it brings back must come.
  for (const id of edit.arriving) if (!after.shows(id)) return `it would not bring back ${id}`;
  for (const id of after.arriving) {
    if (edit.arriving.has(id)) continue;
    for (let at: BlockId | null | undefined = id; typeof at === "string"; at = read.parent(at))
      if (!isOrderKey(read.value("order", at)) && !after.touched.has(at))
        return `it would bring back ${id}, under ${at}, which was removed since`;
  }
  for (const key of edit.shown)
    if (!after.shows(key) && !edit.leaving.has(key)) return `${key}'s text would not show`;
  return null;
}

/**
 * Write every structure value of an edit back (it passed `editStays`), in one commit. A block the
 * edit made goes as a removal through `StructureWriter.remove`, with what this copy reads now, and
 * keeps its other keys to come back with; a removal record put back is written the same way, so a
 * peer's typing it did not read brings the block back (design §1, "Removed blocks"). Returns the
 * change and the values of the way back. `view`, if given, reads the structure as it is; the
 * commit is by `by`.
 */
export function putBackValues(
  docs: RoomDocs,
  values: EditValues,
  view?: StructureView,
  by?: CommitAuthor,
): { change: DocChange | null; values: EditValues } {
  const back: EditValues = new Map();
  if (values.size === 0) return { change: null, values: back };
  const { structure } = docs;
  const before = structure.frontiers();
  const read = view ?? new StructureView(docs);
  const puts = planOf(docs, read, values);
  for (const { name, key, value, at } of puts) {
    if (at === undefined)
      inMap(structure, name, (map) => {
        if (value === undefined) map.delete(key);
        else map.set(key, value as never);
      });
    keysOf(back, name).set(key, { before: values.get(name)?.get(key)?.left, left: undefined });
  }
  // A removal counts the text under it as the run leaves it, a block the run puts back under it
  // included, or the next import answers it with a restore.
  const removals = puts.filter(({ at }) => at !== undefined);
  if (removals.length > 0) {
    const writer = new StructureWriter(
      docs,
      removals.length < puts.length ? new StructureView(docs) : read,
    );
    for (const { key, at } of removals) writer.remove(key, at ?? undefined);
  }
  const change = commitStructure(docs, before, { by });
  for (const [name, keys] of back)
    inMap(structure, name, (map) => {
      for (const [key, value] of keys) {
        value.left = map.get(key);
        value.base = baseThrough(structure, name, key, value.left);
      }
    });
  return { change, values: back };
}

/** A write of a put-back: `at` set makes it a removal of block `key` (null: at its key now). */
interface Put {
  name: string;
  key: string;
  value: unknown;
  at?: string | null;
}

function planOf(docs: RoomDocs, view: StructureView, values: EditValues): Put[] {
  const order = docs.draft ? overrideMap("order") : "order";
  // A block the edit made had no `order` before it; in a draft, none in Live either.
  const made = new Set<BlockId>();
  for (const [id, { before, left }] of values.get(order) ?? [])
    if (
      before === undefined &&
      left !== undefined &&
      (!docs.draft || view.baseValue("order", id) === undefined)
    )
      made.add(id);
  const puts: Put[] = [];
  for (const [name, keys] of values)
    for (const [key, { before, left }] of keys) {
      if (sameValue(before, left)) continue;
      if (name === order && made.has(key)) {
        if (isOrderKey(view.value("order", key)))
          puts.push({ name, key, value: undefined, at: null });
        continue;
      }
      if (name !== order && membersOf(name, key).every((id) => made.has(id))) continue;
      const removal = name === order ? removalOf(before) : null;
      puts.push(
        removal ? { name, key, value: before, at: removal.at } : { name, key, value: before },
      );
    }
  return puts;
}

/**
 * The screen once `values` are put back, by `showRule` over the blocks the plan touches with its
 * writes laid over `view`: only they, the blocks under them and the containers above them can
 * change. `hidden` is every block shown now that would not show, `arriving` every block not shown
 * that would, `touched` the blocks whose order, parent or node the plan writes, and `shows`
 * whether a block would.
 */
function screenAfter(
  docs: RoomDocs,
  view: StructureView,
  values: EditValues,
): {
  hidden: BlockId[];
  arriving: BlockId[];
  touched: ReadonlySet<BlockId>;
  shows(id: BlockId): boolean;
} {
  const { shape } = docs;
  const puts = new Map<string, unknown>();
  const touched = new Set<BlockId>();
  for (const { name, key, value, at } of planOf(docs, view, values)) {
    const map = baseName(name);
    if (map !== "order" && map !== "parent" && map !== "node") continue;
    touched.add(key);
    // A removal reads as any value that is not a key; a deleted override reads Live's value.
    puts.set(
      `${map}\u0000${key}`,
      at !== undefined
        ? "{}"
        : value === undefined && docs.draft
          ? view.baseValue(map, key)
          : value,
    );
  }
  const valueAfter = (map: "parent" | "node", id: BlockId) => {
    const key = `${map}\u0000${id}`;
    return puts.has(key) ? puts.get(key) : view.value(map, id);
  };
  const near = new Set<BlockId>();
  for (const id of touched) {
    for (const below of view.textKeysUnder(id)) near.add(below);
    for (const start of [view.parent(id), valueAfter("parent", id)])
      for (let at = start; typeof at === "string" && !near.has(at); at = view.parent(at))
        near.add(at);
  }
  // A block outside `near` reads as it does now, and so does its parent: the run changes nothing
  // above or under it that the view would read differently.
  const order = `order\u0000`;
  const { shown } = showRule(shape, [...near], {
    placed: (id) =>
      puts.has(order + id) ? isOrderKey(puts.get(order + id)) : typeof view.order(id) === "string",
    parent: (id) => valueAfter("parent", id) as BlockId | null | undefined,
    node: (id) => {
      const node = valueAfter("node", id);
      return typeof node === "string" ? node : undefined;
    },
    outside: {
      shows: (id) => view.shown.has(id),
      children: (id) => view.children(id).filter((child) => !near.has(child)),
    },
  });
  const shows = (id: BlockId) => (near.has(id) ? shown.has(id) : view.shown.has(id));
  return {
    hidden: [...near].filter((id) => view.shown.has(id) && !shown.has(id)),
    arriving: [...shown].filter((id) => !view.shown.has(id)),
    touched,
    shows,
  };
}

const baseName = (name: string): StructureMap =>
  (name.startsWith("d.") ? name.slice(2) : name) as StructureMap;

/**
 * Whether `doc` has ops `then` lacks that are neither `self`'s nor the edit's own (`own`, its ops
 * there: a press's are its draft's writers').
 */
function othersWrote(doc: LoroDoc, then: DocVersion, self: PeerID, own: OpSpans = {}): boolean {
  for (const [peer, counter] of docVersion(doc)) {
    const start = then.get(peer) ?? 0;
    if (peer === self || counter <= start) continue;
    const [from, to] = own[peer] ?? [0, 0];
    if (start < from || counter > Math.max(start, to)) return true;
  }
  return false;
}

/**
 * Whether ops in `doc` since `then` by a peer other than `self` (and outside `own`) still stand
 * (`standingSince`); a take-back that stands and names only ops made since is no write of its own.
 * So a peer's typing it has undone since is no one's write.
 */
function othersStand(doc: LoroDoc, then: DocVersion, self: PeerID, own: OpSpans = {}): boolean {
  if (!othersWrote(doc, then, self, own)) return false;
  const standing = standingSince(doc, then);
  if (!standing) return true;
  for (const ops of standing) {
    if (
      ops.undo &&
      Object.entries(ops.undo.ops).every(([by, [from]]) => from >= (then.get(by as PeerID) ?? 0))
    )
      continue;
    if (ops.peer === self) continue;
    const [from, to] = own[ops.peer] ?? [0, 0];
    if (ops.from >= from && ops.to <= to) continue;
    return true;
  }
  return false;
}

/** Ops `[from, to)` of one peer's change, and what the change's message says it takes back. */
interface StandingOps {
  peer: PeerID;
  from: number;
  to: number;
  undo?: TakeBackNote;
}

/**
 * The ops in `doc` since `then` that still stand, or null where a shallow snapshot cut them (nothing
 * says they were taken back). An op a take-back commit since names (`TakeBackNote.ops`) counts as
 * never made, unless a later take-back names that commit in turn (a Redo of the Undo) (design §2).
 */
function standingSince(doc: LoroDoc, then: DocVersion): StandingOps[] | null {
  const changes: (StandingOps & { lamport: number })[] = [];
  for (const [peer, counter] of docVersion(doc))
    for (let at = then.get(peer) ?? 0; at < counter; ) {
      const change = changeAt(doc, { peer, counter: at });
      if (!change) return null;
      const to = change.counter + change.length;
      const lamport = change.lamport + at - change.counter;
      const { undo } = readCommitMessage(change.message);
      changes.push({ peer, from: at, to, lamport, ...(undo ? { undo } : {}) });
      at = to;
    }
  changes.sort((a, b) => b.lamport - a.lamport || (a.peer < b.peer ? 1 : -1));
  const cancelled = new Map<string, [number, number][]>();
  const out: StandingOps[] = [];
  for (const { peer, from, to, undo } of changes) {
    let stood = false;
    const piece = (start: number, end: number) => {
      if (start >= end) return;
      out.push({ peer, from: start, to: end, ...(undo ? { undo } : {}) });
      stood = true;
    };
    let at = from;
    const spans = (cancelled.get(peer) ?? []).filter(([start, end]) => end > from && start < to);
    for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
      piece(at, start);
      at = Math.max(at, end);
    }
    piece(at, to);
    if (!stood || !undo) continue;
    for (const [by, span] of Object.entries(undo.ops)) {
      const list = cancelled.get(by);
      if (list) list.push(span);
      else cancelled.set(by, [span]);
    }
  }
  return out;
}

export type TextOp = Delta<string>;

/**
 * Why a write (`before` → `after`) to `doc`'s text must stay, by what became of it since, or null:
 * some of the text it put in was deleted (text an Undo deleted and an Undo put back counts as
 * there, by `textSince`, unless `ownTextOnly`: then it counts as deleted, by id); a style it set
 * was set again since over the same text; or, for an edit that set structure (`structural`), some
 * of the text it put in was restyled.
 */
function leftOf(
  doc: LoroDoc,
  before: Frontiers,
  after: Frontiers,
  structural: boolean,
  ownTextOnly: boolean,
): "deleted" | "restyled" | "touched" | null {
  const inserted: Range[] = [];
  const styles: Range[] = [];
  let at = 0;
  for (const op of textDiff(doc, before, after))
    if (op.retain != null) {
      if (op.attributes)
        styles.push({ from: at, to: at + op.retain, keys: Object.keys(op.attributes) });
      at += op.retain;
    } else if (op.insert != null) {
      inserted.push({ from: at, to: at + op.insert.length, keys: [] });
      at += op.insert.length;
    }
  if (inserted.length === 0 && styles.length === 0) return null;
  const since = rangesOf(textSince(doc, after));
  const gone = ownTextOnly ? rangesOf(textDiff(doc, after, doc.frontiers())).gone : since.gone;
  const { styled } = since;
  const overlap = (range: Range, list: Range[], sameKey = false) =>
    list.some(
      (other) =>
        (!sameKey || other.keys.some((key) => range.keys.includes(key))) &&
        Math.min(range.to, other.to) > Math.max(range.from, other.from),
    );
  if (inserted.some((range) => overlap(range, gone))) return "deleted";
  if (styles.some((range) => overlap(range, styled, true))) return "restyled";
  if (structural && inserted.some((range) => overlap(range, styled))) return "touched";
  return null;
}

/** A stretch of text at an edit's `after`, with the styles an op there set. */
type Range = { from: number; to: number; keys: string[] };

/** What a delta over the text at an edit's `after` deleted, and what it restyled. */
function rangesOf(since: readonly TextOp[]): { gone: Range[]; styled: Range[] } {
  const gone: Range[] = [];
  const styled: Range[] = [];
  let at = 0;
  for (const op of since)
    if (op.retain != null) {
      if (op.attributes)
        styled.push({ from: at, to: at + op.retain, keys: Object.keys(op.attributes) });
      at += op.retain;
    } else if (op.delete != null) {
      gone.push({ from: at, to: at + op.delete, keys: [] });
      at += op.delete;
    }
  return { gone, styled };
}

/**
 * What happened to `doc`'s text since `after`, as a delta over the text at `after`, with text an
 * Undo put back read as the text it deleted. An Undo re-creates characters and cannot revive
 * them, so `diff(after, now)` shows a deletion and an insertion where nothing changed. A character
 * put in reads as a deleted one only if a take-back commit wrote it (`TakeBackNote`) for that
 * very character, by id, followed through earlier take-backs, with the same styles. A writer's characters never read as put back, whatever they
 * spell (design §2, "Put-back text is told by the commit that wrote it").
 */
export function textSince(doc: LoroDoc, after: Frontiers): TextOp[] {
  const since = textDiff(doc, after, doc.frontiers());
  if (!since.some((op) => op.delete != null)) return since;
  const roots: StandsForMemo = new Map();
  let base: { units: Unit[]; view: LoroDoc } | null = null;
  try {
    return inText(doc, (text) => {
      const out: TextOp[] = [];
      let pos = 0;
      let now = 0;
      for (let i = 0; i < since.length; ) {
        const op = since[i];
        if (op.retain != null) {
          push(out, op);
          pos += op.retain;
          now += op.retain;
          i++;
          continue;
        }
        let deleted = 0;
        const came: Came[] = [];
        while (i < since.length && since[i].retain == null) {
          const one = since[i++];
          if (one.delete != null) deleted += one.delete;
          else
            for (const ch of (one.insert as string).split(""))
              came.push({ ch, attributes: one.attributes, back: putBy(doc, text, now++, roots) });
        }
        if (!came.some((unit) => unit.back)) {
          if (deleted > 0) push(out, { delete: deleted });
          for (const unit of came) push(out, insertOf(unit));
        } else {
          base ??= unitsAt(doc, after);
          for (const step of align(base.units, base.view, pos, deleted, came)) push(out, step);
        }
        pos += deleted;
      }
      return out;
    });
  } finally {
    (base as { view: LoroDoc } | null)?.view.free();
  }
}

/**
 * Which of the units `since` (`textSince(doc, after)`) inserts, counted in order, stand for one
 * `inverse` (a delta over the text at `after`) deletes: text an Undo put back where it no longer
 * lines up with where it stood (two Undos putting back runs in another order), which a delta
 * reads as typing. The inverse deletes them too, so an edit that goes back goes back whole.
 */
export function putBackOf(
  doc: LoroDoc,
  after: Frontiers,
  inverse: readonly TextOp[],
  since: readonly TextOp[],
): Set<number> {
  const out = new Set<number>();
  if (!since.some((op) => op.insert != null) || !inverse.some((op) => op.delete != null))
    return out;
  const view = doc.fork();
  const deletes = new Set<string>();
  try {
    view.checkout(after);
    inText(view, (text) => {
      let pos = 0;
      for (const op of inverse) {
        if (op.insert != null) continue;
        const n = (op.retain ?? op.delete) as number;
        if (op.delete != null)
          for (let k = 0; k < n; k++) {
            const id = idAt(text, pos + k);
            if (id) deletes.add(id);
          }
        pos += n;
      }
    });
  } finally {
    view.free();
  }
  const memo: StandsForMemo = new Map();
  inText(doc, (text) => {
    let now = 0;
    let unit = 0;
    for (const op of since) {
      if (op.retain != null) now += op.retain;
      else if (op.insert != null)
        for (let k = 0; k < (op.insert as string).length; k++, now++, unit++) {
          const id = idAt(text, now);
          const chain = id ? chainOf(doc, id, memo) : null;
          if (chain && [...chain].some((was) => deletes.has(was))) out.add(unit);
        }
    }
  });
  return out;
}

type Unit = { ch: string; attributes: TextOp["attributes"] };
type Came = Unit & { back: Set<string> | null };

/** The text at `frontiers` as units, and the checked-out copy their ids are read from. */
function unitsAt(doc: LoroDoc, frontiers: Frontiers): { units: Unit[]; view: LoroDoc } {
  const view = doc.fork();
  try {
    view.checkout(frontiers);
    const delta = inText(view, (text) => text.toDelta()) as TextOp[];
    // Positions are UTF-16 code units: a character outside the BMP is two units with one id.
    const units = delta.flatMap((op) =>
      (op.insert ?? "").split("").map((ch) => ({ ch, attributes: op.attributes })),
    );
    return { units, view };
  } catch (error) {
    view.free();
    throw error;
  }
}

/**
 * The deleted units `[pos, pos + n)` of the text at `after` against the units that came at that
 * place: a unit that came is the deleted one it stands for (by id), in order, restyled where its
 * styles differ (a peer's mark around the place spreads onto text put back inside it).
 */
function align(units: Unit[], view: LoroDoc, pos: number, n: number, came: Came[]): TextOp[] {
  const ids = inText(view, (text) => Array.from({ length: n }, (_, k) => idAt(text, pos + k)));
  const out: TextOp[] = [];
  let a = 0;
  for (const unit of came) {
    let match = -1;
    if (unit.back)
      for (let k = a; k < n && match < 0; k++) {
        const id = ids[k];
        if (id && unit.back.has(id)) match = k;
      }
    if (match < 0) {
      out.push(insertOf(unit));
      continue;
    }
    if (match > a) out.push({ delete: match - a });
    const restyle = styleChange(units[pos + match].attributes, unit.attributes);
    out.push(restyle ? { retain: 1, attributes: restyle } : { retain: 1 });
    a = match + 1;
  }
  if (a < n) out.push({ delete: n - a });
  return out;
}

/**
 * What the unit at `pos` stands for, if a take-back commit wrote it: the deleted character it puts
 * back, by id, and what that one stands for in turn. Every link of the chain counts: a press carries
 * a draft's put-back text into Live as itself, so the text at an edit's `after` can be any of them.
 */
function putBy(doc: LoroDoc, text: LoroText, pos: number, memo: StandsForMemo): Set<string> | null {
  const id = idAt(text, pos);
  return id ? chainOf(doc, id, memo) : null;
}

type StandsForMemo = Map<string, Set<string> | null>;

function chainOf(doc: LoroDoc, id: string, memo: StandsForMemo): Set<string> | null {
  if (memo.has(id)) return memo.get(id) ?? null;
  memo.set(id, null);
  const at = parseId(id);
  const change = changeAt(doc, at);
  const runs = readCommitMessage(change?.message).undo?.for;
  const root = change && runs ? nthOf(runs, insertedBefore(doc, change, at.counter)) : null;
  let chain: Set<string> | null = null;
  if (root) {
    chain = new Set([root]);
    for (const further of chainOf(doc, root, memo) ?? []) chain.add(further);
  }
  memo.set(id, chain);
  return chain;
}

/** How many characters `change` inserted before the one at `counter`, in the order it inserted them. */
function insertedBefore(doc: LoroDoc, change: Change, counter: number): number {
  let count = 0;
  for (const json of doc.exportJsonInIdSpan({
    peer: change.peer,
    counter: change.counter,
    length: change.length,
  }))
    for (const op of json.ops) {
      const { content } = op as { content: { type: string; text?: string } };
      if (content.type !== "insert" || content.text === undefined) continue;
      const length = [...content.text].length;
      if (counter < op.counter + length) return count + Math.max(0, counter - op.counter);
      count += length;
    }
  return count;
}

/** The `n`th character of `runs`, as `counter@peer`. */
function nthOf(runs: StandsFor, n: number): string | null {
  for (const [peer, counter, length] of runs) {
    if (n < length) return `${counter + n}@${peer}`;
    n -= length;
  }
  return null;
}

/** Each character the ops in `spans` deleted, by id. Ops below a shallow snapshot's cutoff are unknown. */
function forEachDeleted(
  doc: LoroDoc,
  spans: OpSpans,
  each: (id: { peer: PeerID; counter: number }) => void,
): void {
  const cutoff = doc.isShallow() ? plainVersion(doc.shallowSinceVV()) : null;
  for (const [peer, [start, end]] of Object.entries(spans)) {
    const from = Math.max(start, cutoff?.get(peer as PeerID) ?? 0);
    if (end <= from) continue;
    for (const change of doc.exportJsonInIdSpan({
      peer: peer as PeerID,
      counter: from,
      length: end - from,
    }))
      for (const { content } of change.ops)
        if (content.type === "delete") forDeleteOp(content as DeleteContent, each);
  }
}

type DeleteContent = { start_id: string; len: number };

/**
 * Each character one delete op deleted, by id. A negative `len` is a Backspace run, and its
 * `start_id` is still the lowest id: the op covers `start_id` up, either way.
 */
function forDeleteOp(
  { start_id: startId, len }: DeleteContent,
  each: (id: { peer: PeerID; counter: number }) => void,
): void {
  const first = parseId(startId);
  for (let k = 0; k < Math.abs(len); k++) each({ peer: first.peer, counter: first.counter + k });
}

/** The characters the ops in `spans` deleted in `doc`, by id (`counter@peer`). */
function deletedBy(doc: LoroDoc, spans: OpSpans): Set<string> {
  const ids = new Set<string>();
  forEachDeleted(doc, spans, (id) => ids.add(`${id.counter}@${id.peer}`));
  return ids;
}

/**
 * Whether text the edit deleted (`deleted`, by id) was, since its `after`, deleted again by another
 * peer, itself or a character put back for it, or is shown again as one put back for it: its Undo
 * would put back what that peer took away (a split of it into another block then shows it twice),
 * or show it twice. Only ops that still stand count (`standingSince`): a delete a later Undo took
 * back was never made (design §2). Returns why, or null.
 */
function deletedAgain(
  doc: LoroDoc,
  before: Frontiers,
  after: Frontiers,
  deleted: ReadonlySet<string>,
  peer: PeerID,
): string | null {
  if (deleted.size === 0) return null;
  const standing = standingSince(doc, plainVersion(doc.frontiersToVV(after)));
  if (!standing) return "cut by a snapshot";
  const memo: StandsForMemo = new Map();
  const isDeleted = (id: string) =>
    deleted.has(id) || [...(chainOf(doc, id, memo) ?? [])].some((was) => deleted.has(was));
  let putsBack = false;
  for (const ops of standing) {
    putsBack ||=
      ops.undo?.for.some(([by, counter, length]) =>
        Array.from({ length }, (_, k) => `${counter + k}@${by}`).some(isDeleted),
      ) ?? false;
    if (ops.peer === peer) continue;
    for (const change of doc.exportJsonInIdSpan({
      peer: ops.peer,
      counter: ops.from,
      length: ops.to - ops.from,
    }))
      for (const op of change.ops) {
        if (op.content.type !== "delete") continue;
        let again = false;
        forDeleteOp(op.content as DeleteContent, (id) => {
          again ||= isDeleted(`${id.counter}@${id.peer}`);
        });
        if (again) return "deleted again";
      }
  }
  // Only a take-back that stands since can have put back what the edit deleted.
  if (!putsBack) return null;
  // What the Undo puts back: the characters the edit deleted that showed at its `before`.
  const putBack = new Set(
    deletedBetween(doc, before, after).flatMap(([by, counter, length]) =>
      Array.from({ length }, (_, i) => `${counter + i}@${by}`),
    ),
  );
  return inText(doc, (text) => {
    let now = 0;
    for (const op of textDiff(doc, after, doc.frontiers())) {
      if (op.retain != null) now += op.retain;
      if (op.insert == null) continue;
      for (let k = 0; k < op.insert.length; k++) {
        const chain = putBy(doc, text, now + k, memo);
        if (chain && [...chain].some((was) => deleted.has(was) && putBack.has(was)))
          return "put back by another Undo";
      }
      now += op.insert.length;
    }
    return null;
  });
}

/**
 * Per text doc, what each removal record a peer other than `peer` wrote since `since` (structure
 * frontiers) read of it, whether the removal still stands or a restore answered it. A removal
 * takes the text it read off the screen, as a delete would: a join copies a block's text into the
 * block before and removes it.
 */
function removalsSince(docs: RoomDocs, since: Frontiers, peer: PeerID): Map<DocKey, DocVersion[]> {
  const out = new Map<DocKey, DocVersion[]>();
  const order = docs.draft ? overrideMap("order") : "order";
  const then = plainVersion(docs.structure.frontiersToVV(since));
  for (const [other, counter] of docVersion(docs.structure)) {
    const from = then.get(other) ?? 0;
    if (other === peer || counter <= from) continue;
    for (const change of docs.structure.exportJsonInIdSpan({
      peer: other,
      counter: from,
      length: counter - from,
    }))
      for (const { container, content } of change.ops) {
        if (content.type !== "insert" || mapName(container) !== order) continue;
        const removal = removalOf((content as { value: unknown }).value);
        for (const [key, seen] of removal?.seen ?? [])
          out.set(key, [...(out.get(key) ?? []), seen]);
      }
  }
  return out;
}

/**
 * Whether a removal that read `reads` took off the screen a character the edit deleted
 * (`deleted`): it read the character and not the deletion (not every one of the edit's `ops`),
 * so an Undo would put back text that peer took away.
 */
function readAny(
  reads: readonly DocVersion[],
  deleted: ReadonlySet<string>,
  ops: OpSpans,
): boolean {
  for (const seen of reads) {
    if (Object.entries(ops).every(([peer, [, to]]) => (seen.get(peer as PeerID) ?? 0) >= to))
      continue;
    for (const id of deleted) {
      const { counter, peer: by } = parseId(id);
      if (counter < (seen.get(by) ?? 0)) return true;
    }
  }
  return false;
}

/** The change holding op `id`, or null where a shallow snapshot cut it. */
function changeAt(doc: LoroDoc, id: { peer: PeerID; counter: number }) {
  if (doc.isShallow()) {
    const cutoff = plainVersion(doc.shallowSinceVV());
    if (id.counter < (cutoff.get(id.peer) ?? 0)) return null;
  }
  return doc.getChangeAt(id);
}

/** The id of the character at `pos`, as `counter@peer`. */
function idAt(text: LoroText, pos: number): string | null {
  const cursor = text.getCursor(pos, 0);
  if (!cursor) return null;
  try {
    const id = cursor.pos();
    return id ? `${id.counter}@${id.peer}` : null;
  } finally {
    cursor.free();
  }
}

const parseId = (id: string) => {
  const at = id.indexOf("@");
  return { counter: Number(id.slice(0, at)), peer: id.slice(at + 1) as PeerID };
};

/**
 * The characters the write from `before` to `after` deleted from `doc`'s text, in text order: what
 * an Undo of it inserts, one character for each, in that order (an inverse inserts left to right).
 */
export function deletedBetween(doc: LoroDoc, before: Frontiers, after: Frontiers): StandsFor {
  const diff = textDiff(doc, before, after);
  if (!diff.some((op) => op.delete != null)) return [];
  const view = doc.fork();
  try {
    view.checkout(before);
    return inText(view, (text) => {
      const out: StandsFor = [];
      let pos = 0;
      let last: string | null = null;
      for (const op of diff) {
        if (op.insert != null) continue;
        const n = (op.retain ?? op.delete) as number;
        if (op.delete != null)
          for (let k = 0; k < n; k++) {
            const id = idAt(text, pos + k);
            // A character outside the BMP is two units with one id.
            if (!id || id === last) continue;
            last = id;
            const { peer, counter } = parseId(id);
            const run = out.at(-1);
            if (run && run[0] === peer && run[1] + run[2] === counter) run[2]++;
            else out.push([peer, counter, 1]);
          }
        pos += n;
      }
      return out;
    });
  } finally {
    view.free();
  }
}

/**
 * The ops `peer` made in `doc` from `before` to `after`, or with no `peer` every peer's.
 */
export function opsBetween(
  doc: LoroDoc,
  before: Frontiers,
  after: Frontiers,
  peer?: PeerID,
): OpSpans {
  const from = plainVersion(doc.frontiersToVV(before));
  const out: OpSpans = {};
  for (const [by, to] of plainVersion(doc.frontiersToVV(after)))
    if ((peer === undefined || by === peer) && to > (from.get(by) ?? 0))
      out[by] = [from.get(by) ?? 0, to];
  return out;
}

/** The delta of `doc`'s text from `from` to `to`. */
export function textDiff(doc: LoroDoc, from: Frontiers, to: Frontiers): TextOp[] {
  const hit = doc.diff(from, to, false).find(([, diff]) => diff.type === "text");
  return hit ? ((hit[1] as { diff?: TextOp[] }).diff ?? []) : [];
}

/** What takes styles `was` to `now`, or null: a style set or changed to its value, one cleared to null. */
function styleChange(
  was: TextOp["attributes"],
  now: TextOp["attributes"],
): TextOp["attributes"] | null {
  const change: NonNullable<TextOp["attributes"]> = {};
  for (const [key, value] of Object.entries(now ?? {}))
    if (value != null && !sameValue(was?.[key], value)) change[key] = value;
  for (const [key, value] of Object.entries(was ?? {}))
    if (value != null && now?.[key] == null) change[key] = null;
  return Object.keys(change).length > 0 ? change : null;
}

const insertOf = ({ ch, attributes }: Came): TextOp =>
  (attributes ? { insert: ch, attributes } : { insert: ch }) as TextOp;

function push(out: TextOp[], op: TextOp): void {
  const last = out.at(-1);
  if (op.retain != null && !op.attributes && last?.retain != null && !last.attributes)
    (last as { retain: number }).retain += op.retain;
  else if (op.delete != null && last?.delete != null)
    (last as { delete: number }).delete += op.delete;
  else out.push({ ...op });
}

function keysOf(values: EditValues, name: string): Map<string, SetValue> {
  let keys = values.get(name);
  if (!keys) {
    keys = new Map();
    values.set(name, keys);
  }
  return keys;
}

/** The structure doc holds root maps only: `cid:root-<name>:Map`. */
const mapName = (container: string) => container.slice("cid:root-".length, -":Map".length);
