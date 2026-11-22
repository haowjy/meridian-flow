import type { Frontiers, LoroDoc } from "loro-crdt";
import { orderKeys, type Random } from "./order-key.js";
import {
  commentVisibility,
  normalizeInline,
  readInline,
  revivedBlock,
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
  overrideMap,
  type ShapeBlock,
  STRUCTURE_KEY,
  type StructureMap,
  sameValue,
  storedAttrs,
  TEXT_KEY,
} from "./shape.js";
import { type Removal, StructureView, type TextRead, textRead } from "./structure.js";
import { patchStyles, replaceUnits, type TextRules, wantedUnits } from "./text.js";

/** One doc a write changed, with its frontiers either side: what an Undo record holds. */
export interface DocChange {
  key: DocKey;
  doc: LoroDoc;
  before: Frontiers;
  after: Frontiers;
}

/** A doc's update from `before` on: the ops one change wrote, to publish. */
export function changeUpdate(doc: LoroDoc, before: Frontiers): Uint8Array {
  return before.length === 0
    ? doc.export({ mode: "update" })
    : doc.export({ mode: "update", from: doc.frontiersToVV(before) });
}

export interface WriteOptions {
  /** The commit message: `turn:<id>`, `press:<id>`, or none for the writer's own typing. */
  message?: string;
  /** The commit origin local subscribers see (the binding skips its own). */
  origin?: string;
  random?: Random;
  /**
   * What the docs read as now, when the caller holds it (the editor's document before a
   * transaction). A block of the write that is the same object as here, under the same parent, is
   * known to read as written and is not compared again, so a write costs what it changed.
   */
  previous?: readonly ShapeBlock[];
}

/**
 * Writes structure values the way every writer must (design §1): Live's copy writes Live's maps;
 * a draft's fork writes only its `d.*` overrides, and deletes an override whose value equals Live's
 * instead of writing it, so a matching override never hides Live's later edits of the key.
 * Comparisons read the `StructureView` taken before the write.
 */
export class StructureWriter {
  constructor(
    readonly docs: RoomDocs,
    readonly view: StructureView,
  ) {}

  set(name: StructureMap, key: string, value: unknown): void {
    const { structure, draft } = this.docs;
    const base = this.view.baseValue(name, key);
    if (!draft) {
      if (!sameValue(base, value)) structure.getMap(name).set(key, value as never);
      return;
    }
    const overrides = structure.getMap(overrideMap(name));
    const override = this.view.override(name, key);
    const baseRead = name === "attrs" ? (base ?? null) : base;
    if (sameValue(baseRead, value)) {
      if (override !== undefined) overrides.delete(key);
    } else if (!sameValue(override, value)) overrides.set(key, value as never);
  }

  /**
   * Remove a block (what is under it hides with it): `order` becomes a
   * `Removal` holding what it read of every text doc under it, so text edited concurrently brings
   * the block back (design §1, "Removed blocks").
   */
  remove(id: BlockId): void {
    const seen: Record<DocKey, TextRead> = {};
    for (const key of this.view.textKeysUnder(id)) {
      const doc = this.docs.textOf(key);
      if (doc) seen[key] = textRead(doc);
    }
    const removal: Removal = { at: this.view.order(id) as string, seen };
    this.set("order", id, removal);
  }

  /**
   * Store the key of `id` and of every block above it that shows only because it was revived.
   * A write into a revived block (its text, attributes or children) restores it, so the write
   * cannot hide it again (the writer deleting the text that revived it, or moving it out).
   */
  keep(id: BlockId): void {
    for (let at: BlockId | null | undefined = id; at && this.view.revived.has(at); ) {
      this.set("order", at, this.view.order(at));
      at = this.view.parent(at);
    }
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
   * counts, so Reset of that removal leaves the block where the draft moved it.
   */
  dropMatchingOverrides(ids: Iterable<BlockId>) {
    if (!this.docs.draft) return;
    const { structure } = this.docs;
    const after = new StructureView(this.docs);
    const orders = structure.getMap(overrideMap("order"));
    for (const id of ids) if (sameOrderAsBase(after, id)) orders.delete(id);
    const comments = structure.getMap(overrideMap("comments"));
    for (const key of after.overrideKeys("comments"))
      if (sameValue(after.baseValue("comments", key), after.override("comments", key)))
        comments.delete(key);
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
  if (typeof override !== "string" || typeof base !== "string") return false;
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
  if (body === null && !docs.draft) docs.structure.getMap("comments").delete(comment);
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
  let view: StructureView | undefined;
  let writer: StructureWriter | undefined;
  const read = () => {
    view ??= new StructureView(docs);
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
      for (const [id, key] of orderKeys(ids, current, random)) structure().set("order", id, key);
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
      if (revivedBlock(docs, block.id)) structure().keep(block.id);
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
  docs.structure.commit({ message: options.message, origin: options.origin });
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
): DocChange | null {
  const wantedItems = normalizeInline(inline);
  const current = readInline(docs.textOf(id), rules.rule, rules.shape, rules.visibleComment);
  if (sameValue(current, wantedItems)) return null;
  const { doc, before } = docs.writableText(id);
  const wanted = wantedUnits(wantedItems);
  const shown = shownUnits(doc, rules.rule, rules.shape);
  const splice = spliceOf(
    shown.map((unit) => unit.ch).join(""),
    wanted.map((unit) => unit.ch).join(""),
  );
  replaceUnits(
    doc,
    rules,
    splice.index,
    splice.index + splice.remove,
    wanted.slice(splice.index, splice.index + splice.insert),
  );
  patchStyles(doc.getText(TEXT_KEY), shownUnits(doc, rules.rule, rules.shape), wanted, rules);
  doc.commit({ message: options.message, origin: options.origin });
  const after = doc.frontiers();
  return sameValue(before, after) ? null : { key: id, doc, before, after };
}

/** The splice from `a` to `b`: common prefix and suffix, never splitting a surrogate pair. */
function spliceOf(a: string, b: string): { index: number; remove: number; insert: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) start--;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (endA < a.length && isLowSurrogate(a.charCodeAt(endA)) && endA > start) {
    endA++;
    endB++;
  }
  return { index: start, remove: endA - start, insert: endB - start };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
