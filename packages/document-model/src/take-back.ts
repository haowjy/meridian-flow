import type { Delta, Frontiers, LoroDoc, LoroText, PeerID } from "loro-crdt";
import { inMap, inText } from "./handles.js";
import type { RoomDocs } from "./room-docs.js";
import { type BlockId, type DocKey, overrideMap, type StructureMap, sameValue } from "./shape.js";
import { isOrderKey, removalOf, StructureView } from "./structure.js";
import { type DocVersion, docVersion, plainVersion } from "./version.js";
import { commitStructure, type DocChange, StructureWriter } from "./write.js";

/**
 * The rule every Undo follows (design §2, "An Undo takes an edit back whole, or leaves it whole"):
 * an edit (a Ctrl+Z step, or one change of a press) goes back only while nobody else has written
 * over it, and then goes back whole. The editor's `UndoHistory` tests its steps with it; a press's
 * Undo will too. Nothing here knows how the edit's text is taken back (Loro's `UndoManager` in the
 * editor, an inverse on the server).
 */

/** A structure value an edit set: what the key held before the edit, and what the edit left. */
export interface SetValue {
  before: unknown;
  left: unknown;
}

/** An edit's structure values, by stored map name (`order`, a draft's `d.order`) then key. */
export type EditValues = Map<string, Map<string, SetValue>>;

/** The frontiers either side of what an edit, or its last run, wrote in one text doc. */
export interface TextSpan {
  before: Frontiers;
  after: Frontiers;
}

/** What the rule needs of an edit. `noteEdit` fills `leaving` and `shown` after each write or run. */
export interface Edit {
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
}

/**
 * Add to `into` the structure keys the commits from `before` to `after` set: for a key not in it
 * yet the value before them, and for every key the value they left.
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
      const value = keys.get(key);
      if (value) value.left = left;
      else keys.set(key, { before: was?.type === "map" ? was.updated[key] : undefined, left });
    }
  }
  return into;
}

/**
 * Note, after the edit was written or run, what its next run would take off the screen and bring
 * onto it, and which of its text docs show. A block leaves with its text as the removal record the
 * run puts back read it (typing that record did not read brought the block back, and must keep
 * it), or as it is now. An edit that set no structure takes nothing away and needs no note.
 */
export function noteEdit(docs: RoomDocs, edit: Edit): void {
  edit.leaving.clear();
  edit.arriving.clear();
  edit.shown.clear();
  if (edit.values.size === 0) return;
  const view = new StructureView(docs);
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
 * Why `edit` must stay, or null when it can go back whole: every key it set holds what it left
 * (1); every block its run would take off the screen is one it would have taken when noted, with
 * no one else's write in its text since, and the blocks it would bring onto the screen the ones
 * it would have brought (2: a block a peer removed since, with what is under it, stays removed);
 * no style it set was set again over the same text, and no text it deleted was deleted again; every text doc it wrote that showed still shows or
 * leaves with it (3); and of the text it put in, some is left, or for an edit that set structure
 * all of it, untouched (4). "Written over" is by another peer: this copy's own untracked writes
 * (an upload landing, a restore) never keep an edit. `view`, if given, reads the docs as they are.
 */
export function editStays(docs: RoomDocs, edit: Edit, view?: StructureView): string | null {
  const self = docs.peer;
  for (const [name, keys] of edit.values) {
    const why = inMap(docs.structure, name, (map) => {
      for (const [key, { before, left }] of keys)
        if (
          !sameValue(before, left) &&
          !sameValue(map.get(key), left) &&
          map.getLastEditor(key) !== self
        )
          return `${name}[${key}] was written over`;
      return null;
    });
    if (why) return why;
  }
  const structural = edit.values.size > 0;
  for (const [key, { before, after }] of edit.texts) {
    const doc = docs.textOf(key);
    if (!doc || !othersWrote(doc, plainVersion(doc.frontiersToVV(after)), self)) continue;
    if (deletedAgain(doc, before, after, self))
      return `text it deleted in ${key} was deleted again`;
    const { left, touched, restyled } = leftOf(doc, before, after);
    if (restyled) return `a style it set in ${key} was set again`;
    // An edit that set structure moved text between blocks by copy, and its Undo brings the
    // original back beside what is left of the copy: the copy must be whole.
    if (left === "none" || (structural && (left === "some" || touched)))
      return `of what it put into ${key}, ${touched && left === "all" ? "some was restyled" : `${left} is left`}`;
  }
  if (!structural) return null;
  const read = view ?? new StructureView(docs);
  const after = screenAfter(docs, read, edit.values);
  for (const id of after.hidden) {
    if (!edit.leaving.has(id)) return `it would take ${id} off the screen`;
    const doc = docs.textOf(id);
    if (doc && othersWrote(doc, edit.leaving.get(id) ?? new Map(), self))
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
 * change and the values of the way back. `view`, if given, reads the structure as it is.
 */
export function putBackValues(
  docs: RoomDocs,
  values: EditValues,
  view?: StructureView,
): { change: DocChange | null; values: EditValues } {
  const back: EditValues = new Map();
  if (values.size === 0) return { change: null, values: back };
  const { structure } = docs;
  const before = structure.frontiers();
  const read = view ?? new StructureView(docs);
  const writer = new StructureWriter(docs, read);
  for (const { name, key, value, at } of planOf(docs, read, values)) {
    if (at !== undefined) writer.remove(key, at ?? undefined);
    else
      inMap(structure, name, (map) => {
        if (value === undefined) map.delete(key);
        else map.set(key, value as never);
      });
    keysOf(back, name).set(key, { before: values.get(name)?.get(key)?.left, left: undefined });
  }
  const change = commitStructure(docs, before, {});
  for (const [name, keys] of back)
    inMap(structure, name, (map) => {
      for (const [key, value] of keys) value.left = map.get(key);
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
      if (name !== order && !isComments(name) && made.has(blockOf(name, key))) continue;
      const removal = name === order ? removalOf(before) : null;
      puts.push(
        removal ? { name, key, value: before, at: removal.at } : { name, key, value: before },
      );
    }
  return puts;
}

/**
 * The screen once `values` are put back, worked out from `view` around the blocks the plan
 * touches: only they, the blocks under them and the containers above them can change. `hidden` is
 * every block shown now that would not show, `arriving` every block not shown that would,
 * `touched` the blocks whose order, parent or node the plan writes, and `shows` whether a block
 * would.
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
  const valueAfter = (map: "order" | "parent" | "node", id: BlockId) => {
    const key = `${map}\u0000${id}`;
    if (puts.has(key)) return puts.get(key);
    return map === "parent" ? view.parent(id) : view.value(map, id);
  };
  const near = new Set<BlockId>();
  for (const id of touched) {
    for (const below of view.textKeysUnder(id)) near.add(below);
    for (const start of [view.parent(id), valueAfter("parent", id)])
      for (let at = start; typeof at === "string" && !near.has(at); at = view.parent(at))
        near.add(at);
  }
  // A container's children after: those shown now, and every block near it, shown or not, that
  // the plan leaves under it (a hidden row comes back with the table it is in).
  const nearChildren = new Map<BlockId, BlockId[]>();
  for (const id of near) {
    const parent = valueAfter("parent", id);
    if (typeof parent === "string")
      nearChildren.set(parent, [...(nearChildren.get(parent) ?? []), id]);
  }
  // As `StructureView` reads: a block shows when its order is a key, its node is known and its
  // parent shows; then orphans and required containers left with nothing go, until none does.
  const memo = new Map<BlockId, boolean>();
  const placed = (id: BlockId): boolean => {
    if (!near.has(id)) return view.shown.has(id);
    const known = memo.get(id);
    if (known !== undefined) return known;
    // A cycle the plan would make reads as hidden: the edit then stays.
    memo.set(id, false);
    const node = valueAfter("node", id);
    const parent = valueAfter("parent", id);
    const ok =
      isOrderKey(valueAfter("order", id)) &&
      typeof node === "string" &&
      shape.node(node) !== undefined &&
      (parent === null || (typeof parent === "string" && placed(parent)));
    memo.set(id, ok);
    return ok;
  };
  const after = new Set([...near].filter(placed));
  const shows = (id: BlockId) => (near.has(id) ? after.has(id) : view.shown.has(id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of after) {
      const parent = valueAfter("parent", id);
      const rule = shape.node(valueAfter("node", id) as string);
      const orphan = typeof parent === "string" && !shows(parent);
      const empty =
        rule?.required === true &&
        !rule.fillable &&
        ![...view.children(id), ...(nearChildren.get(id) ?? [])].some(
          (child) =>
            valueAfter("parent", child) === id &&
            shows(child) &&
            rule.accepts(valueAfter("node", child) as string),
        );
      if (orphan || empty) {
        after.delete(id);
        changed = true;
      }
    }
  }
  return {
    hidden: [...near].filter((id) => view.shown.has(id) && !after.has(id)),
    arriving: [...after].filter((id) => !view.shown.has(id)),
    touched,
    shows,
  };
}

const baseName = (name: string): StructureMap =>
  (name.startsWith("d.") ? name.slice(2) : name) as StructureMap;

/** Whether a peer other than `self` has ops in `doc` that `then` lacks. */
function othersWrote(doc: LoroDoc, then: DocVersion, self: PeerID): boolean {
  for (const [peer, counter] of docVersion(doc))
    if (peer !== self && counter > (then.get(peer) ?? 0)) return true;
  return false;
}

export type TextOp = Delta<string>;

/**
 * What became of a write (`before` → `after`) to `doc`'s text: how much of the text it put in is
 * there now (all, some or none; text an Undo deleted and an Undo put back counts as there, by
 * `textSince`), whether any of that text was restyled since (`touched`), and whether a style it
 * set was set again since over the same text (`restyled`).
 */
export function leftOf(
  doc: LoroDoc,
  before: Frontiers,
  after: Frontiers,
): { left: "all" | "some" | "none"; touched: boolean; restyled: boolean } {
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
  if (inserted.length === 0 && styles.length === 0)
    return { left: "all", touched: false, restyled: false };
  const gone: Range[] = [];
  const styled: Range[] = [];
  at = 0;
  for (const op of textSince(doc, after))
    if (op.retain != null) {
      if (op.attributes)
        styled.push({ from: at, to: at + op.retain, keys: Object.keys(op.attributes) });
      at += op.retain;
    } else if (op.delete != null) {
      gone.push({ from: at, to: at + op.delete, keys: [] });
      at += op.delete;
    }
  const overlap = (range: Range, list: Range[], sameKey = false) =>
    list.reduce(
      (n, other) =>
        sameKey && !other.keys.some((key) => range.keys.includes(key))
          ? n
          : n + Math.max(0, Math.min(range.to, other.to) - Math.max(range.from, other.from)),
      0,
    );
  let total = 0;
  let lost = 0;
  let touched = false;
  for (const range of inserted) {
    total += range.to - range.from;
    lost += overlap(range, gone);
    touched ||= overlap(range, styled) > 0;
  }
  const restyled = styles.some((range) => overlap(range, styled, true) > 0);
  return { left: lost === 0 ? "all" : lost === total ? "none" : "some", touched, restyled };
}

/** A stretch of text at an edit's `after`, with the styles an op there set. */
type Range = { from: number; to: number; keys: string[] };

/**
 * What happened to `doc`'s text since `after`, as a delta over the text at `after`, with text an
 * Undo put back read as the text it deleted. An Undo re-creates characters and cannot revive
 * them, so `diff(after, now)` shows a deletion and an insertion where nothing changed. A character
 * put in reads as a deleted one only if a commit that takes ops back wrote it (`takeBackMessage`)
 * and the ops it took back deleted that very character, by id, followed through earlier
 * take-backs, with the same styles. A writer's characters never read as put back, whatever they
 * spell (design §2, "Put-back text is told by the commit that wrote it").
 */
export function textSince(doc: LoroDoc, after: Frontiers): TextOp[] {
  const since = textDiff(doc, after, doc.frontiers());
  if (!since.some((op) => op.delete != null)) return since;
  const roots = new Map<string, Set<string>>();
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
              came.push({
                ch,
                attributes: one.attributes,
                key: unitKey(ch, one.attributes),
                back: putBy(doc, text, now++, roots),
              });
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

type Unit = { ch: string; key: string };
type Came = Unit & { attributes: TextOp["attributes"]; back: Set<string> | null };

/** The text at `frontiers` as units, and the checked-out copy their ids are read from. */
function unitsAt(doc: LoroDoc, frontiers: Frontiers): { units: Unit[]; view: LoroDoc } {
  const view = doc.fork();
  try {
    view.checkout(frontiers);
    const delta = inText(view, (text) => text.toDelta()) as TextOp[];
    // Positions are UTF-16 code units: a character outside the BMP is two units with one id.
    const units = delta.flatMap((op) =>
      (op.insert ?? "").split("").map((ch) => ({ ch, key: unitKey(ch, op.attributes) })),
    );
    return { units, view };
  } catch (error) {
    view.free();
    throw error;
  }
}

/**
 * The deleted units `[pos, pos + n)` of the text at `after` against the units that came at that
 * place: a unit that came is the deleted one it stands for (by id, with the same styles), in order.
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
        if (id && units[pos + k].key === unit.key && unit.back.has(id)) match = k;
      }
    if (match < 0) {
      out.push(insertOf(unit));
      continue;
    }
    if (match > a) out.push({ delete: match - a });
    out.push({ retain: 1 });
    a = match + 1;
  }
  if (a < n) out.push({ delete: n - a });
  return out;
}

/** The ids the edits a take-back commit names deleted, if a take-back commit wrote the unit at `pos`. */
function putBy(
  doc: LoroDoc,
  text: LoroText,
  pos: number,
  memo: Map<string, Set<string>>,
): Set<string> | null {
  const id = idAt(text, pos);
  if (!id) return null;
  const spans = takenBack(changeAt(doc, parseId(id))?.message);
  return spans ? rootsOf(doc, spans, memo) : null;
}

/**
 * The characters the ops in `spans` deleted, by id, each followed to what it stands for: one a
 * take-back commit wrote stands for what that commit's ops deleted. Ops below a shallow
 * snapshot's cutoff are unknown and stand for nothing.
 */
function rootsOf(doc: LoroDoc, spans: TakenBack, memo: Map<string, Set<string>>): Set<string> {
  const key = JSON.stringify(spans);
  const known = memo.get(key);
  if (known) return known;
  const roots = new Set<string>();
  memo.set(key, roots);
  forEachDeleted(doc, spans, (id) => {
    const earlier = takenBack(changeAt(doc, id)?.message);
    if (earlier) for (const root of rootsOf(doc, earlier, memo)) roots.add(root);
    else roots.add(`${id.counter}@${id.peer}`);
  });
  return roots;
}

/** Each character the ops in `spans` deleted, by id. Ops below a shallow snapshot's cutoff are unknown. */
function forEachDeleted(
  doc: LoroDoc,
  spans: TakenBack,
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
      for (const { content } of change.ops) {
        if (content.type !== "delete") continue;
        const { start_id: startId, len } = content as { start_id: string; len: number };
        const first = parseId(startId);
        const step = len < 0 ? -1 : 1;
        for (let k = 0; k < Math.abs(len); k++)
          each({ peer: first.peer, counter: first.counter + step * k });
      }
  }
}

/**
 * Whether another peer deleted, since `after`, a character `self` deleted from `before` to
 * `after`: the Undo would put back text that peer took away (a split of it into another block
 * then shows it twice).
 */
function deletedAgain(doc: LoroDoc, before: Frontiers, after: Frontiers, self: PeerID): boolean {
  const mine = new Set<string>();
  forEachDeleted(doc, opsBetween(doc, before, after, self), (id) =>
    mine.add(`${id.counter}@${id.peer}`),
  );
  if (mine.size === 0) return false;
  const then = plainVersion(doc.frontiersToVV(after));
  const others: TakenBack = {};
  for (const [peer, counter] of docVersion(doc))
    if (peer !== self && counter > (then.get(peer) ?? 0))
      others[peer] = [then.get(peer) ?? 0, counter];
  let again = false;
  forEachDeleted(doc, others, (id) => {
    again ||= mine.has(`${id.counter}@${id.peer}`);
  });
  return again;
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

/** The ops a take-back commit takes back, per peer, as `[from, to)` counters. */
export type TakenBack = Record<string, [number, number]>;

const TAKE_BACK = "undo";

/**
 * The message of a commit that takes ops back (a tab's Undo or Redo, a press's Undo): which ops,
 * so text it puts back can be told from typing (`textSince`). A Redo takes back its Undo's ops.
 */
export function takeBackMessage(spans: TakenBack): string {
  return `${TAKE_BACK} ${JSON.stringify(spans)}`;
}

/** The ops a commit's message says it takes back, or null. Messages come from any peer. */
export function takenBack(message: string | undefined): TakenBack | null {
  if (!message?.startsWith(`${TAKE_BACK} `)) return null;
  let spans: unknown;
  try {
    spans = JSON.parse(message.slice(TAKE_BACK.length + 1));
  } catch {
    return null;
  }
  if (spans === null || typeof spans !== "object") return null;
  for (const span of Object.values(spans))
    if (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isInteger)) return null;
  return spans as TakenBack;
}

/** The ops `peer` made in `doc` from `before` to `after`, as a take-back message names them. */
export function opsBetween(
  doc: LoroDoc,
  before: Frontiers,
  after: Frontiers,
  peer: PeerID,
): TakenBack {
  const from = plainVersion(doc.frontiersToVV(before)).get(peer) ?? 0;
  const to = plainVersion(doc.frontiersToVV(after)).get(peer) ?? 0;
  return to > from ? { [peer]: [from, to] } : {};
}

function textDiff(doc: LoroDoc, from: Frontiers, to: Frontiers): TextOp[] {
  const hit = doc.diff(from, to, false).find(([, diff]) => diff.type === "text");
  return hit ? ((hit[1] as { diff?: TextOp[] }).diff ?? []) : [];
}

/** A unit as a comparable key: its character and its styles, sorted, a `null` style dropped. */
const unitKey = (ch: string, attributes: TextOp["attributes"]) =>
  `${ch}\u0000${JSON.stringify(
    Object.entries(attributes ?? {})
      .filter(([, value]) => value != null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )}`;

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

const isComments = (name: string) => name === "comments" || name === overrideMap("comments");

/** The block an `attrs` key (`id/name`) belongs to; every other block map is keyed by block id. */
const blockOf = (name: string, key: string) =>
  name.endsWith("attrs") ? key.slice(0, key.lastIndexOf("/")) : key;

/** The structure doc holds root maps only: `cid:root-<name>:Map`. */
const mapName = (container: string) => container.slice("cid:root-".length, -":Map".length);
