import type { Frontiers, LoroDoc } from "loro-crdt";
import { orderKeys, type Random } from "./order-key.js";
import {
  commentVisibility,
  isDerivedEmpty,
  normalizeInline,
  readInline,
  shownUnits,
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
import { StructureView } from "./structure.js";
import { patchStyles, replaceUnits, type TextRules, wantedUnits } from "./text.js";

/** One doc a write changed, with its frontiers either side: what an Undo record holds. */
export interface DocChange {
  key: DocKey;
  doc: LoroDoc;
  before: Frontiers;
  after: Frontiers;
}

export interface WriteOptions {
  /** The commit message: `turn:<id>`, `press:<id>`, or none for the writer's own typing. */
  message?: string;
  /** The commit origin local subscribers see (the binding skips its own). */
  origin?: string;
  random?: Random;
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

  /** Remove a block (and what shows under it reads as removed with it): `order` to null. */
  remove(id: BlockId): void {
    this.set("order", id, null);
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
    const after = new StructureView(structure, true, this.docs.shape);
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
  const view = new StructureView(docs.structure, docs.draft, docs.shape);
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
 * blocks that left are tombstoned, and a textblock's text doc gets a splice and a style patch.
 * Because the comparison is against the normalized read, a broken cycle, a hidden container or a
 * filled empty cell writes nothing by itself, and after the write the docs read as `blocks`.
 * Returns the docs it changed, committed.
 */
export function writeDocument(
  docs: RoomDocs,
  blocks: readonly ShapeBlock[],
  options: WriteOptions = {},
): DocChange[] {
  const { shape } = docs;
  const view = new StructureView(docs.structure, docs.draft, shape);
  const writer = new StructureWriter(docs, view);
  const before = docs.structure.frontiers();
  const random = options.random ?? Math.random;
  const visibleComment = commentVisibility(view);
  const changes: DocChange[] = [];
  const written = new Set<BlockId>();

  const walk = (list: readonly ShapeBlock[], parent: BlockId | null) => {
    const stored = list.filter((block) => !isDerivedEmpty(block, parent));
    const current = new Map(
      stored.map((block) => {
        const order = view.parent(block.id) === parent ? view.order(block.id) : undefined;
        return [block.id, typeof order === "string" ? order : undefined] as const;
      }),
    );
    for (const [id, key] of orderKeys(
      stored.map((block) => block.id),
      current,
      random,
    ))
      writer.set("order", id, key);
    const ids = stored.map((block) => block.id);
    for (const block of stored) {
      if (written.has(block.id)) throw new Error(`block id ${block.id} appears twice`);
      written.add(block.id);
      const moved =
        writer.brokenCycle(block.id, parent) && movedAmong(view.children(parent), ids, block.id);
      writer.block(block.id, parent, block.node, block.attrs, moved);
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
  writer.dropMatchingOverrides(written);
  for (const id of view.shown) if (!written.has(id)) writer.remove(id);
  const structure = commitStructure(docs, before, options);
  if (structure) changes.unshift(structure);
  return changes;
}

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
