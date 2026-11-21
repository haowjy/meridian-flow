import type { Delta, Frontiers, LoroDoc } from "loro-crdt";
import { orderKeys, type Random } from "./order-key.js";
import {
  commentVisibility,
  emptyParagraphId,
  normalizeInline,
  normalizeMarks,
  readInline,
  type TextUnit,
  textUnits,
} from "./read.js";
import type { RoomDocs } from "./room-docs.js";
import {
  type BlockId,
  type CommentBody,
  type DocKey,
  INLINE_STYLE,
  type InlineItem,
  type NodeRule,
  overrideMap,
  SENTINEL,
  type ShapeBlock,
  type ShapeSchema,
  STRUCTURE_KEY,
  type StructureMap,
  sameValue,
  storedAttrs,
  TEXT_KEY,
} from "./shape.js";
import { StructureView } from "./structure.js";

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

  /** Every key of a new or changed block but its order. */
  block(
    id: BlockId,
    parent: BlockId | null,
    node: string,
    attrs: Readonly<Record<string, unknown>>,
  ) {
    this.set("parent", id, parent);
    this.set("node", id, node);
    const stored = storedAttrs(attrs);
    for (const name of new Set([...Object.keys(this.view.attrs(id)), ...Object.keys(stored)]))
      this.set("attrs", `${id}/${name}`, stored[name] ?? null);
  }

  /**
   * In a draft, delete the `d.order` of a block whose override puts it in the same place among its
   * siblings as Live's key would (dragged away and back), and every `d.comments` equal to Live's.
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
 * filled empty cell writes nothing by itself. Returns the docs it changed, committed.
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
    const stored = list.filter((block) => !isUnstoredEmpty(block, parent));
    const current = new Map(
      stored.map((block) => {
        const order =
          view.value("parent", block.id) === parent ? view.value("order", block.id) : undefined;
        return [block.id, typeof order === "string" ? order : undefined] as const;
      }),
    );
    for (const [id, key] of orderKeys(
      stored.map((block) => block.id),
      current,
      random,
    ))
      writer.set("order", id, key);
    for (const block of stored) {
      if (written.has(block.id)) throw new Error(`block id ${block.id} appears twice`);
      written.add(block.id);
      writer.block(block.id, parent, block.node, block.attrs);
      if (block.kind === "container") walk(block.children, block.id);
      else {
        const rule = shape.node(block.node);
        if (!rule) throw new Error(`unknown node ${block.node}`);
        const change = writeText(docs, block.id, block.inline, rule, visibleComment, options);
        if (change) changes.push(change);
      }
    }
  };
  walk(blocks, null);
  for (const id of view.shown) if (!written.has(id)) writer.remove(id);
  writer.dropMatchingOverrides(written);
  const structure = commitStructure(docs, before, options);
  if (structure) changes.unshift(structure);
  return changes;
}

/** The empty paragraph a reader shows in an empty cell or document, before anything is typed into it. */
function isUnstoredEmpty(block: ShapeBlock, parent: BlockId | null): boolean {
  return (
    block.kind === "text" &&
    block.node === "paragraph" &&
    block.inline.length === 0 &&
    block.id === emptyParagraphId(parent)
  );
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
 * (the change's `before` is then the frontier it forked at).
 */
export function writeText(
  docs: RoomDocs,
  id: BlockId,
  inline: readonly InlineItem[],
  rule: NodeRule,
  visibleComment: (comment: string) => boolean,
  options: WriteOptions,
): DocChange | null {
  const wanted = normalizeInline(inline);
  if (sameValue(readInline(docs.textOf(id), rule, docs.shape, visibleComment), wanted)) return null;
  const { doc, before } = docs.writableText(id);
  updateText(doc, wanted, rule, docs.shape, visibleComment);
  doc.commit({ message: options.message, origin: options.origin });
  const after = doc.frontiers();
  return sameValue(before, after) ? null : { key: id, doc, before, after };
}

/** The units `items` stand for, each with the style object it is stored with. */
function wantedUnits(
  items: readonly InlineItem[],
): { ch: string; style: Record<string, unknown> }[] {
  const out: { ch: string; style: Record<string, unknown> }[] = [];
  for (const item of items) {
    if (item.kind === "inline")
      out.push({
        ch: SENTINEL,
        style: { ...item.marks, [INLINE_STYLE]: { type: item.node, attrs: item.attrs } },
      });
    else
      for (let i = 0; i < item.text.length; i++)
        out.push({ ch: item.text[i], style: { ...item.marks } });
  }
  return out;
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

/**
 * Splice the visible text to the wanted text, then patch styles unit by unit where the normalized
 * marks differ. Units the reader hides (an inline node the block's type does not allow, a style the
 * normalizer drops) are left alone, so a write-back never deletes what it could not see.
 */
function updateText(
  doc: LoroDoc,
  items: readonly InlineItem[],
  rule: NodeRule,
  shape: ShapeSchema,
  visibleComment: (comment: string) => boolean,
) {
  const text = doc.getText(TEXT_KEY);
  const wanted = wantedUnits(items);
  let units = textUnits(doc, rule, shape);
  let visible = units.filter((unit) => !unit.hidden);
  const splice = spliceOf(
    visible.map((unit) => unit.ch).join(""),
    wanted.map((unit) => unit.ch).join(""),
  );
  const removed = visible.slice(splice.index, splice.index + splice.remove).map((unit) => unit.pos);
  for (let end = removed.length; end > 0; ) {
    let start = end - 1;
    while (start > 0 && removed[start - 1] === removed[start] - 1) start--;
    text.delete(removed[start], removed[end - 1] - removed[start] + 1);
    end = start;
  }
  if (splice.insert > 0) {
    units = textUnits(doc, rule, shape);
    visible = units.filter((unit) => !unit.hidden);
    const at = splice.index < visible.length ? visible[splice.index].pos : units.length;
    const delta: Delta<string>[] = at > 0 ? [{ retain: at }] : [];
    for (const unit of wanted.slice(splice.index, splice.index + splice.insert)) {
      const last = delta.at(-1);
      if (last?.insert !== undefined && sameValue(last.attributes ?? {}, unit.style))
        last.insert += unit.ch;
      else delta.push({ insert: unit.ch, attributes: unit.style } as Delta<string>);
    }
    text.applyDelta(delta);
  }
  units = textUnits(doc, rule, shape);
  const styles: Delta<string>[] = [];
  let next = 0;
  for (const unit of units) {
    let patch: Record<string, unknown> | null = null;
    if (!unit.hidden) {
      const want = wanted[next++];
      if (want?.ch !== unit.ch)
        throw new Error("text differs from the wanted text after its splice");
      patch = stylePatch(unit, want.style, rule, shape, visibleComment);
    }
    const last = styles.at(-1);
    if (last && sameValue(last.attributes ?? null, patch)) (last as { retain: number }).retain += 1;
    else styles.push((patch ? { retain: 1, attributes: patch } : { retain: 1 }) as Delta<string>);
  }
  while (styles.length > 0 && !styles.at(-1)?.attributes) styles.pop();
  if (styles.length > 0) text.applyDelta(styles);
}

function stylePatch(
  unit: TextUnit,
  want: Record<string, unknown>,
  rule: NodeRule,
  shape: ShapeSchema,
  visibleComment: (comment: string) => boolean,
): Record<string, unknown> | null {
  const shown: Record<string, unknown> = {
    ...normalizeMarks(unit.stored, rule, shape, visibleComment),
  };
  if (unit.ch === SENTINEL && unit.stored[INLINE_STYLE] !== undefined) {
    const inline = unit.stored[INLINE_STYLE] as { type: string; attrs?: Record<string, unknown> };
    shown[INLINE_STYLE] = { type: inline.type, attrs: storedAttrs(inline.attrs ?? {}) };
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(want))
    if (!sameValue(shown[key], value)) patch[key] = value;
  for (const key of Object.keys(shown)) if (!(key in want)) patch[key] = null;
  return Object.keys(patch).length > 0 ? patch : null;
}
