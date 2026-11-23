import type { Frontiers, LoroDoc } from "loro-crdt";
import {
  type CommitAuthor,
  type CommitNote,
  commitMessage,
  type StandsFor,
} from "./commit-message.js";
import { commonEnds } from "./common-ends.js";
import { encodeEnvelope } from "./envelope.js";
import { inMap, inText } from "./handles.js";
import { orderKeys, type Random } from "./order-key.js";
import { retirePieces, textDiffers } from "./pieces.js";
import {
  commentVisibility,
  emptyParagraphOf,
  normalizeInline,
  readInline,
  shownUnits,
  storedOf,
  structureValues,
} from "./read.js";
import type { RoomDocs } from "./room-docs.js";
import {
  type BlockId,
  type CommentBody,
  type DocKey,
  type InlineItem,
  membersOf,
  overrideMap,
  pieceKey,
  SETTLED_MAP,
  type ShapeBlock,
  STRUCTURE_KEY,
  type StructureMap,
  sameValue,
  settledKey,
  storedAttrs,
} from "./shape.js";
import { encodeRemoval, isOrderKey, StructureView } from "./structure.js";
import { patchStyles, replaceUnits, type TextRules, type WantedUnit, wantedUnits } from "./text.js";
import { type DocVersion, docVersion, plainVersion } from "./version.js";

/** One doc a write changed, with its frontiers either side: what an Undo record holds. */
export interface DocChange {
  key: DocKey;
  doc: LoroDoc;
  before: Frontiers;
  after: Frontiers;
}

/**
 * The batch that sends `changes`: per doc, the update from its first change's `before` on (a doc
 * a transaction wrote twice sends once).
 */
export function encodeChanges(changes: readonly DocChange[]): Uint8Array {
  const entries = new Map<DocKey, Uint8Array>();
  for (const change of changes)
    if (!entries.has(change.key)) entries.set(change.key, changeUpdate(change.doc, change.before));
  return encodeEnvelope(entries);
}

/** A doc's update from `before` on: the ops one change wrote. */
function changeUpdate(doc: LoroDoc, before: Frontiers): Uint8Array {
  if (before.length === 0) return doc.export({ mode: "update" });
  const from = doc.frontiersToVV(before);
  try {
    return doc.export({ mode: "update", from });
  } finally {
    from.free();
  }
}

export interface WriteOptions {
  /** Who the write is by (its commit message, `commitMessage`); none is the writer's own typing. */
  by?: CommitAuthor;
  /** The commit origin local subscribers see (the binding skips its own). */
  origin?: string;
  random?: Random;
  /**
   * What the docs read as now, when the caller holds it (the editor's document before a
   * transaction). A block of the write that is the same object as here, under the same parent, is
   * known to read as written and is not compared again, so a write costs what it changed.
   */
  previous?: readonly ShapeBlock[];
  /**
   * Removed blocks the caller's document still shows (the editor's caret rule, design §1): the
   * write reads the docs as `readDocument` does with them, so it leaves them as they are.
   */
  kept?: ReadonlySet<BlockId>;
  /** The read of the structure with `kept` as it is now, when the caller already took it. */
  view?: StructureView;
  /** What this write moved between blocks: the writer knows it from the edit it is writing. */
  moved?: Moved;
}

/**
 * What one write moved between blocks (a split, a join, a paste, a drop). A draft records each
 * pair so the two blocks are one change (design §2). Each stretch of text carried whole goes in
 * as a copy that names the characters it stands for (`CopyNote`), so a block coming back takes
 * its copies out wherever they stand (`restore`, design §1).
 */
export interface Moved {
  pieces: readonly (readonly [BlockId, BlockId])[];
  copies: readonly MovedText[];
}

/** `length` units of `from` at `was` now stand in `into` at `at`, as the editor counts units. */
export interface MovedText {
  from: BlockId;
  into: BlockId;
  was: number;
  at: number;
  length: number;
}

/** A copy for `writeText`: the units at `at` it writes stand for `for`, in `from`'s text doc. */
interface Copy {
  from: BlockId;
  at: number;
  for: StandsFor;
}

/**
 * Writes structure values the way every writer must (design §1): Live's copy writes Live's maps;
 * a draft's fork writes only its `d.*` overrides, and deletes an override whose value equals Live's
 * instead of writing it, so a matching override never hides Live's later edits of the key. Every
 * write of an override takes back a press's settling of that key (`unsettle`). Comparisons read the
 * `StructureView` taken before the write.
 */
export class StructureWriter {
  /** The blocks (and comments) whose values this writer set, for `retirePieces`. */
  readonly touched = new Set<string>();
  /** The `pieces` records this writer made, which its write never retires (`retirePieces`). */
  readonly recorded = new Set<string>();

  constructor(
    readonly docs: RoomDocs,
    readonly view: StructureView,
  ) {}

  set(name: StructureMap, key: string, value: unknown): void {
    for (const member of membersOf(name, key)) this.touched.add(member);
    const { structure, draft } = this.docs;
    const base = this.view.baseValue(name, key);
    if (!draft) {
      if (!sameValue(base, value)) inMap(structure, name, (map) => map.set(key, value as never));
      return;
    }
    this.unsettle(name, key);
    const override = this.view.rawOverride(name, key);
    const baseRead = name === "attrs" ? (base ?? null) : base;
    if (sameValue(baseRead, value)) {
      if (override !== undefined) inMap(structure, overrideMap(name), (map) => map.delete(key));
    } else if (!sameValue(override, value))
      inMap(structure, overrideMap(name), (map) => map.set(key, value as never));
  }

  /**
   * A write of an override takes back a press's settling of it (`d.settled`), in the same commit:
   * the override is the writer's again, even where the writer sets the very value the press read,
   * for which Loro writes no op.
   */
  private unsettle(name: StructureMap, key: string): void {
    const settled = settledKey(name, key);
    inMap(this.docs.structure, SETTLED_MAP, (map) => {
      if (map.get(settled) !== undefined) map.delete(settled);
    });
  }

  /**
   * Remove a block, and with it what is under it: `order` becomes a record of the key it had (`at`)
   * and what this copy read of every text doc under it, so a write the removal did not read can
   * bring it back (design §1, "Removed blocks"). Writers remove only the topmost block of what
   * they remove. `at` is given when an Undo writes a removal record back (`putBackValues`).
   */
  remove(id: BlockId, at = this.view.order(id) as string): void {
    const seen = new Map<DocKey, DocVersion>();
    for (const key of this.view.textKeysUnder(id)) {
      const doc = this.docs.textOf(key);
      // The version the copy shows, not its oplog's: a view checked out at a read (`RoomDocs.at`)
      // holds ops it never showed.
      if (doc) seen.set(key, plainVersion(doc.version()));
    }
    this.set("order", id, encodeRemoval({ at, seen }));
  }

  /**
   * Record that this write moved text between `a` and `b`, so a draft's review takes them as one
   * change. Live keeps no record: nothing reviews it.
   */
  pieces(a: BlockId, b: BlockId): void {
    if (!this.docs.draft || a === b) return;
    const { peer, structure } = this.docs;
    const key = pieceKey(a, b, `${peer}@${docVersion(structure).get(peer) ?? 0}`);
    this.recorded.add(key);
    this.set("pieces", key, true);
  }

  /**
   * Every key of a new or changed block but its order. A parent the read moved to the document to
   * break a cycle is left as stored when the write leaves the block where it read (same parent,
   * `moved` false), so writing back an unchanged read writes nothing (and in a draft makes no
   * override the writer never made). A block the write moves among its siblings gets its parent
   * written, or the move would be lost once the cycle is mended.
   */
  block(
    id: BlockId,
    parent: BlockId | null,
    node: string,
    attrs: Readonly<Record<string, unknown>>,
    moved = false,
  ) {
    if (moved || !this.brokenCycle(id, parent)) this.set("parent", id, parent);
    this.set("node", id, node);
    const stored = storedAttrs(attrs);
    for (const name of new Set([...Object.keys(this.view.attrs(id)), ...Object.keys(stored)]))
      this.set("attrs", `${id}/${name}`, stored[name] ?? null);
  }

  /** The read shows `id` under `parent` only because it broke a cycle there. */
  brokenCycle(id: BlockId, parent: BlockId | null): boolean {
    const read = this.view.parent(id);
    return read === parent && read !== this.view.value("parent", id);
  }

  /**
   * In a draft, delete the `d.order` of a block whose override puts it in the same place among its
   * siblings as Live's key would (dragged away and back), and every `d.comments` equal to Live's.
   * Run before the write's removals, as the gate's model does: a sibling the write removes still
   * counts, so a Discard of that removal leaves the block where the draft moved it. One drop can
   * make a sibling's override match too (two blocks dragged back past each other), so each drop is
   * judged against the order the drops before it left.
   */
  dropMatchingOverrides(ids: Iterable<BlockId>) {
    if (!this.docs.draft) return;
    const { structure } = this.docs;
    const left = new Set(ids);
    inMap(structure, overrideMap("order"), (orders) => {
      for (;;) {
        const now = new StructureView(this.docs, this.view.kept);
        const id = [...left].find((candidate) => sameOrderAsBase(now, candidate));
        if (id === undefined) break;
        orders.delete(id);
        this.unsettle("order", id);
        left.delete(id);
        this.touched.add(id);
      }
    });
    const after = new StructureView(this.docs, this.view.kept);
    inMap(structure, overrideMap("comments"), (comments) => {
      for (const key of after.overrideKeys("comments"))
        if (sameValue(after.baseValue("comments", key), after.override("comments", key))) {
          comments.delete(key);
          this.unsettle("comments", key);
        }
    });
  }
}

/** Whether `id` has other siblings before it in `written` than in `read`, among those in both. */
function movedAmong(read: readonly BlockId[], written: readonly BlockId[], id: BlockId): boolean {
  const inRead = new Set(read);
  const inWritten = new Set(written);
  const before = (list: readonly BlockId[], keep: Set<BlockId>) =>
    new Set(list.slice(0, list.indexOf(id)).filter((other) => keep.has(other)));
  const was = before(read, inWritten);
  const now = before(written, inRead);
  return was.size !== now.size || [...was].some((other) => !now.has(other));
}

function sameOrderAsBase(view: StructureView, id: BlockId): boolean {
  const override = view.override("order", id);
  const base = view.baseValue("order", id);
  if (!isOrderKey(override) || !isOrderKey(base)) return false;
  if (view.baseValue("parent", id) !== view.value("parent", id)) return false;
  const parent = view.parent(id) ?? null;
  for (const other of view.children(parent)) {
    if (other === id) continue;
    const key = view.order(other) as string;
    const side = (mine: string) => (mine < key ? -1 : mine > key ? 1 : id < other ? -1 : 1);
    if (side(override) !== side(base)) return false;
  }
  return true;
}

/** Set a comment's body (null deletes it), override-aware like every structure write. */
export function setCommentBody(
  docs: RoomDocs,
  comment: string,
  body: CommentBody | null,
  options: WriteOptions = {},
) {
  const view = new StructureView(docs);
  const before = docs.structure.frontiers();
  const writer = new StructureWriter(docs, view);
  if (body === null && !docs.draft) inMap(docs.structure, "comments", (map) => map.delete(comment));
  else writer.set("comments", comment, body);
  return commitStructure(docs, before, options);
}

/**
 * Write a whole document as the editor (or a seed) has it (design §6): diff it against the
 * normalized read and write only what differs. Blocks pair by `id`, so there is nothing to
 * reconcile: changed values are set, only blocks whose relative order changed are re-keyed, shown
 * blocks that left are tombstoned (the topmost of each removed subtree), and a textblock's text doc
 * gets a splice and a style patch.
 * Because the comparison is against the normalized read, a broken cycle, a hidden container or a
 * filled empty cell writes nothing by itself, and after the write the docs read as `blocks`.
 * With `options.previous`, blocks unchanged since it are skipped. Returns the docs it changed,
 * committed.
 */
export function writeDocument(
  docs: RoomDocs,
  blocks: readonly ShapeBlock[],
  options: WriteOptions = {},
): DocChange[] {
  const { shape } = docs;
  const known = options.previous && indexOf(options.previous);
  // With `previous`, the structure is read only when the write changes it: a change to text alone
  // reads and writes only the text docs it changed.
  let view = options.view;
  let writer: StructureWriter | undefined;
  const read = () => {
    view ??= new StructureView(docs, options.kept);
    return view;
  };
  const structure = () => {
    writer ??= new StructureWriter(docs, read());
    return writer;
  };
  const before = docs.structure.frontiers();
  const random = options.random ?? Math.random;
  const visibleComment = commentVisibility(known ? structureValues(docs) : read());
  const changes: DocChange[] = [];
  const copies = options.moved?.copies.length
    ? copiesOf(docs, read, options.moved.copies)
    : new Map<BlockId, Copy[]>();
  const written = new Set<BlockId>();
  const take = (id: BlockId) => {
    if (written.has(id)) throw new Error(`block id ${id} appears twice`);
    written.add(id);
  };
  const keep = (block: ShapeBlock) => {
    take(block.id);
    if (block.kind === "container") for (const child of block.children) keep(child);
  };

  const walk = (list: readonly ShapeBlock[], parent: BlockId | null) => {
    const stored = storedOf(list, parent);
    const ids = stored.map((block) => block.id);
    const reordered = !sameIds(
      known ? (known.children.get(parent) ?? []) : read().children(parent),
      ids,
    );
    if (reordered) {
      const current = new Map(
        stored.map((block) => {
          const order = read().parent(block.id) === parent ? read().order(block.id) : undefined;
          return [block.id, typeof order === "string" ? order : undefined] as const;
        }),
      );
      // A key as read is left as stored: a kept block's is the key its record holds, and stays.
      for (const [id, key] of orderKeys(ids, current, random, read().kept))
        if (key !== current.get(id)) structure().set("order", id, key);
    }
    for (const block of stored) {
      const moved =
        reordered &&
        structure().brokenCycle(block.id, parent) &&
        movedAmong(read().children(parent), ids, block.id);
      const was = known?.blocks.get(block.id);
      const inPlace = !moved && was !== undefined && was.parent === parent;
      if (inPlace && was.block === block) {
        keep(block);
        continue;
      }
      take(block.id);
      // Only a row stored before the placeholder rule may hold one (design §1); a new one is a
      // caller that skipped giving the paragraph a fresh id.
      if (emptyParagraphOf(block.id) !== undefined && read().node(block.id) === undefined)
        throw new Error(`block id ${block.id} is a placeholder, never stored`);
      if (!inPlace || was.block.node !== block.node || !sameValue(was.block.attrs, block.attrs))
        structure().block(block.id, parent, block.node, block.attrs, moved);
      if (block.kind === "container") walk(block.children, block.id);
      else {
        const rule = shape.node(block.node);
        if (!rule) throw new Error(`unknown node ${block.node}`);
        const change = writeText(
          docs,
          block.id,
          block.inline,
          { rule, shape, visibleComment },
          options,
          copies.get(block.id),
        );
        if (change) changes.push(change);
      }
    }
  };
  walk(blocks, null);
  const left = !known || [...known.blocks.keys()].some((id) => !written.has(id));
  if (docs.draft || writer || left) structure().dropMatchingOverrides(written);
  if (left)
    for (const id of read().shown) {
      // A block under a removed block hides with it, and comes back with it.
      const parent = read().parent(id);
      const goesWithParent = typeof parent === "string" && !written.has(parent);
      if (!written.has(id) && !goesWithParent) structure().remove(id);
    }
  if (docs.draft) {
    for (const [a, b] of options.moved?.pieces ?? []) structure().pieces(a, b);
    // A block shown after the write with other text than Live's is changed; a typed block left
    // with Live's text is the only one a keystroke can settle.
    const shown = (id: BlockId) => written.has(id) && !options.kept?.has(id);
    const typed = changes.map((change) => change.key).filter((id) => !textDiffers(docs, id));
    retirePieces(
      docs,
      [...(writer?.touched ?? []), ...typed],
      (id) => shown(id) && textDiffers(docs, id),
      writer?.recorded,
    );
  }
  const committed = commitStructure(docs, before, options);
  if (committed) changes.unshift(committed);
  return changes;
}

/** `previous` by id: each stored block and its parent, and each parent's stored children in order. */
function indexOf(previous: readonly ShapeBlock[]) {
  const blocks = new Map<BlockId, { block: ShapeBlock; parent: BlockId | null }>();
  const children = new Map<BlockId | null, BlockId[]>();
  const walk = (list: readonly ShapeBlock[], parent: BlockId | null) => {
    const stored = storedOf(list, parent);
    for (const block of stored) {
      blocks.set(block.id, { block, parent });
      if (block.kind === "container") walk(block.children, block.id);
    }
    children.set(
      parent,
      stored.map((block) => block.id),
    );
  };
  walk(previous, null);
  return { blocks, children };
}

const sameIds = (a: readonly BlockId[], b: readonly BlockId[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export function commitStructure(
  docs: RoomDocs,
  before: Frontiers,
  options: WriteOptions,
): DocChange | null {
  docs.structure.commit({ message: commitMessage({ by: options.by }), origin: options.origin });
  const after = docs.structure.frontiers();
  return sameValue(before, after)
    ? null
    : { key: STRUCTURE_KEY, doc: docs.structure, before, after };
}

/**
 * Bring block `id`'s text doc to `inline` if its normalized read differs; returns the change. A
 * new block's doc is created at its first content, and a draft forks Live's doc at its first write
 * (the change's `before` is then the frontier it forked at). The text gets one splice (common
 * prefix and suffix of the shown text) and the units outside it a style patch.
 */
export function writeText(
  docs: RoomDocs,
  id: BlockId,
  inline: readonly InlineItem[],
  rules: TextRules,
  options: WriteOptions,
  copies: readonly Copy[] = [],
): DocChange | null {
  const wantedItems = normalizeInline(inline);
  const current = readInline(docs.textOf(id), rules.rule, rules.shape, rules.visibleComment);
  if (sameValue(current, wantedItems)) return null;
  const { doc, before } = docs.writableText(id);
  const wanted = wantedUnits(wantedItems);
  const write = (target: readonly WantedUnit[], note: CommitNote) => {
    const shown = shownUnits(doc, rules.rule, rules.shape);
    const splice = spliceOf(
      shown.map((unit) => unit.ch).join(""),
      target.map((unit) => unit.ch).join(""),
    );
    replaceUnits(
      doc,
      rules,
      splice.index,
      splice.index + splice.remove,
      target.slice(splice.index, splice.index + splice.insert),
    );
    inText(doc, (text) =>
      patchStyles(text, shownUnits(doc, rules.rule, rules.shape), target, rules),
    );
    doc.commit({ message: commitMessage(note), origin: options.origin });
  };
  // Each copy goes in by a commit of its own, whose note names what its characters stand for:
  // first the text without them, then each copy in order.
  const placed = copies
    .filter((copy) => copy.at >= 0 && copy.at + lengthOf(copy.for) <= wanted.length)
    .sort((a, b) => a.at - b.at)
    .filter((copy, i, all) => i === 0 || all[i - 1].at + lengthOf(all[i - 1].for) <= copy.at);
  const without = (from: number) =>
    wanted.filter(
      (_, at) =>
        !placed.some((copy, i) => i >= from && copy.at <= at && at < copy.at + lengthOf(copy.for)),
    );
  write(without(0), { by: options.by });
  for (const [i, copy] of placed.entries())
    write(without(i + 1), { by: options.by, copy: { from: copy.from, for: copy.for } });
  const after = doc.frontiers();
  return sameValue(before, after) ? null : { key: id, doc, before, after };
}

const lengthOf = (runs: StandsFor) => runs.reduce((sum, [, , length]) => sum + length, 0);

/**
 * The copies `moved` makes, by the block they go into: the characters of each stretch read from
 * the text it was carried from, before the write changes it. A stretch whose units do not all
 * read there (the caller's document and the docs disagree) is written as plain text.
 */
function copiesOf(docs: RoomDocs, view: () => StructureView, moved: readonly MovedText[]) {
  const out = new Map<BlockId, Copy[]>();
  for (const { from, into, was, at, length } of moved) {
    const doc = docs.textOf(from);
    const rule = doc && docs.shape.node(view().node(from) ?? "");
    if (!doc || !rule || length <= 0) continue;
    const units = shownUnits(doc, rule, docs.shape).slice(was, was + length);
    if (units.length !== length) continue;
    const runs = inText(doc, (text) => {
      const out: StandsFor = [];
      for (const unit of units) {
        const cursor = text.getCursor(unit.pos, 0);
        const id = cursor?.pos();
        cursor?.free();
        if (!id) return null;
        const last = out.at(-1);
        if (last && last[0] === id.peer && last[1] + last[2] === id.counter) last[2]++;
        else out.push([id.peer, id.counter, 1]);
      }
      return out;
    });
    if (!runs) continue;
    const list = out.get(into) ?? [];
    list.push({ from, at, for: runs });
    out.set(into, list);
  }
  return out;
}

/** The splice from `a` to `b`: common prefix and suffix, never splitting a surrogate pair. */
function spliceOf(a: string, b: string): { index: number; remove: number; insert: number } {
  let { start, end } = commonEnds(a, b);
  if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(a.charCodeAt(a.length - end)) && a.length - end > start) end--;
  return { index: start, remove: a.length - end - start, insert: b.length - end - start };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
