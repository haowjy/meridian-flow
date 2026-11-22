import type { Delta, LoroDoc } from "loro-crdt";
import { inMap, inText } from "./handles.js";
import type { RoomDocs } from "./room-docs.js";
import {
  type Attrs,
  type BlockId,
  COMMENT_STYLE_PREFIX,
  type DocKey,
  INLINE_STYLE,
  type InlineItem,
  type Marks,
  markNameOf,
  type NodeRule,
  overrideMap,
  SENTINEL,
  type ShapeBlock,
  type ShapeSchema,
  STRUCTURE_KEY,
  sameValue,
  storedAttrs,
} from "./shape.js";
import { StructureView } from "./structure.js";

/**
 * The id every peer gives the unstored empty paragraph of a cell, container or document with no
 * shown block, so two peers typing into it first make one block (`/empty` for the document).
 */
export const emptyParagraphId = (parent: BlockId | null) => `${parent ?? ""}/empty`;

const derivedEmpty = (parent: BlockId | null): ShapeBlock => ({
  kind: "text",
  id: emptyParagraphId(parent),
  node: "paragraph",
  attrs: {},
  inline: [],
});

/**
 * The unstored empty paragraph rule, for writers: if `id` is the empty paragraph this read shows
 * in an empty fillable container (or document), the parent it shows in (null: the document);
 * otherwise undefined. A writer that puts anything into it (text, attributes) stores it first,
 * under this parent, with this id; a block placed after it is placed first.
 */
export function derivedEmptyParent(
  view: StructureView,
  shape: ShapeSchema,
  id: BlockId,
): BlockId | null | undefined {
  const suffix = emptyParagraphId(null);
  if (!id.endsWith(suffix) || view.shown.has(id)) return undefined;
  const parent = id.length === suffix.length ? null : id.slice(0, -suffix.length);
  if (parent !== null && !view.shown.has(parent)) return undefined;
  const node = parent === null ? shape.root : view.node(parent);
  if (node === undefined || !shape.node(node)?.fillable) return undefined;
  return view.children(parent).length === 0 ? parent : undefined;
}

/** Whether `block`, written under `parent`, is the derived empty paragraph still holding nothing. */
export function isDerivedEmpty(block: ShapeBlock, parent: BlockId | null): boolean {
  return (
    block.kind === "text" &&
    block.id === emptyParagraphId(parent) &&
    block.node === "paragraph" &&
    block.inline.length === 0 &&
    Object.keys(storedAttrs(block.attrs)).length === 0
  );
}

/**
 * The blocks of a child list that are stored: all of them, unless the list is only the unstored
 * empty paragraph a reader shows in an empty container. An empty paragraph with that id beside
 * others (Enter in an empty cell) is stored like any block, or the editor would show a paragraph
 * the docs do not hold.
 */
export function storedOf(
  list: readonly ShapeBlock[],
  parent: BlockId | null,
): readonly ShapeBlock[] {
  return list.length === 1 && isDerivedEmpty(list[0], parent) ? [] : list;
}

/**
 * What a reader read before, to read again by what changed since (`readDocument`'s `since`).
 * `blocks` is what the docs read as then, `comments` the comments it saw bodies of then
 * (`visibleComments`), and `changed` every doc key whose state changed since.
 */
export interface ReadSince {
  blocks: readonly ShapeBlock[];
  comments: ReadonlySet<string>;
  changed: ReadonlySet<DocKey>;
}

/**
 * The read normalizer (design §1): what every reader shows, identically and without writing an op.
 * Loro merges concurrent ops into states the schema forbids, and this is the one place they read
 * as something valid:
 *
 * - a run carrying an exclusive mark (`code`) shows it alone; a mark the block's node type does
 *   not allow is dropped;
 * - `inline` on any character but U+FFFC is ignored, a U+FFFC without it is text, and an inline
 *   node the block's type does not allow is not shown;
 * - a `comment_<c>` style whose body the reader cannot see shows nothing;
 * - structure: `StructureView`'s parent, cycle and empty-container rules, and a fillable container
 *   with no shown block shows an empty paragraph with id `<parent id>/empty`.
 *
 * With `since`, only what changed is read again, and every block that reads as it did is
 * `since`'s own object (so a caller can tell unchanged blocks by identity): a batch that touched
 * only text docs re-reads those blocks' text and no structure; one that touched the structure
 * reads the structure and the text docs in `changed`. The result is the same as a full read.
 *
 * `kept` names removed blocks to show at their record's key though they are removed (the
 * editor's caret rule, design §1); `since.blocks` must then be the read with the same `kept`.
 */
export function readDocument(
  docs: RoomDocs,
  since?: ReadSince,
  kept?: ReadonlySet<BlockId>,
): ShapeBlock[] {
  if (since && !since.changed.has(STRUCTURE_KEY)) {
    const texts = readTexts(docs, since);
    if (texts) return texts;
  }
  return readBlocks(docs, new StructureView(docs, kept), since);
}

function readBlocks(docs: RoomDocs, view: StructureView, since?: ReadSince): ShapeBlock[] {
  const shape = docs.shape;
  const visibleComment = commentVisibility(view);
  const previous = since ? blocksById(since.blocks) : new Map<BlockId, ShapeBlock>();
  const reread = since?.changed ?? new Set<DocKey>();
  // A comment whose body came or went changes how every text doc reads.
  const textsHold = since ? sameSet(since.comments, visibleComments(docs)) : false;
  const one = (id: BlockId): ShapeBlock => {
    const node = view.node(id) as string;
    const rule = shape.node(node) as NodeRule;
    const attrs = view.attrs(id);
    const was = previous.get(id);
    const same = was !== undefined && was.node === node && sameValue(was.attrs, attrs);
    if (rule.textblock) {
      if (same && was.kind === "text" && textsHold && !reread.has(id)) return was;
      return {
        kind: "text",
        id,
        node,
        attrs,
        inline: readInline(docs.textOf(id), rule, shape, visibleComment),
      };
    }
    const children = view.children(id).map(one);
    if (children.length === 0 && rule.fillable)
      children.push(emptyParagraph(id, was?.kind === "container" ? was.children : undefined));
    if (same && was.kind === "container" && sameList(was.children, children)) return was;
    return { kind: "container", id, node, attrs, children };
  };
  const blocks = view.children(null).map(one);
  if (blocks.length === 0 && shape.node(shape.root)?.fillable)
    blocks.push(emptyParagraph(null, since?.blocks));
  return blocks;
}

/**
 * The read after a batch that changed text docs only: the blocks named in `changed` read again,
 * the rest as they were. Null when a changed key is an empty paragraph's id, whose read depends
 * on whether the structure stores it.
 */
function readTexts(docs: RoomDocs, since: ReadSince): ShapeBlock[] | null {
  for (const key of since.changed) if (key.endsWith(emptyParagraphId(null))) return null;
  const visibleComment = commentVisibility(structureValues(docs));
  const again = (block: ShapeBlock): ShapeBlock => {
    if (block.kind === "text") {
      if (!since.changed.has(block.id)) return block;
      const rule = docs.shape.node(block.node) as NodeRule;
      return {
        ...block,
        inline: readInline(docs.textOf(block.id), rule, docs.shape, visibleComment),
      };
    }
    const children = block.children.map(again);
    return sameList(block.children, children) ? block : { ...block, children };
  };
  return since.blocks.map(again);
}

/** The unstored empty paragraph of `parent`: the one read before, if it showed one then. */
function emptyParagraph(parent: BlockId | null, was?: readonly ShapeBlock[]): ShapeBlock {
  return was?.length === 1 && isDerivedEmpty(was[0], parent) ? was[0] : derivedEmpty(parent);
}

/** The stored blocks of `blocks` by id: an unstored empty paragraph is no block to reuse. */
function blocksById(blocks: readonly ShapeBlock[]): Map<BlockId, ShapeBlock> {
  const out = new Map<BlockId, ShapeBlock>();
  const walk = (list: readonly ShapeBlock[], parent: BlockId | null) => {
    for (const block of storedOf(list, parent)) {
      out.set(block.id, block);
      if (block.kind === "container") walk(block.children, block.id);
    }
  };
  walk(blocks, null);
  return out;
}

const sameList = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);

const sameSet = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) =>
  a.size === b.size && [...a].every((item) => b.has(item));

/** The comments this reader sees a body of (Live's `comments`, or a draft's override of it). */
export function visibleComments(docs: RoomDocs): Set<string> {
  const { structure } = docs;
  const keys = new Set(inMap(structure, "comments", (map) => map.keys()));
  if (docs.draft)
    for (const key of inMap(structure, overrideMap("comments"), (map) => map.keys())) keys.add(key);
  const visible = commentVisibility(structureValues(docs));
  return new Set([...keys].filter(visible));
}

/**
 * Whether this reader sees comment `id`'s body: Live's `comments`, or a draft's override of it.
 * `values` is a `StructureView`, or `structureValues` where a read of every map costs too much.
 */
export function commentVisibility(
  values: Pick<StructureView, "value">,
): (comment: string) => boolean {
  return (comment) => {
    const body = values.value("comments", comment);
    return body !== undefined && body !== null;
  };
}

/** `StructureView.value` read key by key from the doc, for a write that reads a few keys. */
export function structureValues(docs: RoomDocs): Pick<StructureView, "value"> {
  const get = (name: string, key: string) => inMap(docs.structure, name, (map) => map.get(key));
  return {
    value(name, key) {
      const override = docs.draft ? get(overrideMap(name), key) : undefined;
      return override === undefined ? get(name, key) : override;
    },
  };
}

/** A textblock's text doc, normalized. A block with no text doc yet reads as empty. */
export function readInline(
  doc: LoroDoc | undefined,
  rule: NodeRule,
  shape: ShapeSchema,
  visibleComment: (comment: string) => boolean,
): InlineItem[] {
  const out: InlineItem[] = [];
  let stored: TextUnit["stored"] | null = null;
  let marks: Marks = {};
  for (const unit of textUnits(doc, rule, shape)) {
    if (unit.hidden) continue;
    if (unit.stored !== stored) {
      stored = unit.stored;
      marks = normalizeMarks(stored, rule, shape, visibleComment);
    }
    if (unit.inline)
      out.push({ kind: "inline", node: unit.inline.node, attrs: unit.inline.attrs, marks });
    else pushText(out, unit.ch, marks);
  }
  return out;
}

/** The stored marks of one character as a reader sees them. */
export function normalizeMarks(
  stored: Readonly<Record<string, unknown>>,
  rule: NodeRule,
  shape: ShapeSchema,
  visibleComment: (comment: string) => boolean,
): Marks {
  const keys = Object.keys(stored).filter(
    (key) =>
      key !== INLINE_STYLE &&
      stored[key] !== null &&
      stored[key] !== undefined &&
      rule.allowsMark(markNameOf(key)) &&
      (!key.startsWith(COMMENT_STYLE_PREFIX) ||
        visibleComment(key.slice(COMMENT_STYLE_PREFIX.length))),
  );
  const exclusive = keys.find((key) => shape.exclusiveMarks.has(key));
  const out: Record<string, unknown> = {};
  for (const key of exclusive ? [exclusive] : keys) out[key] = stored[key];
  return out;
}

function inlineStyle(value: unknown): { node: string; attrs: Attrs } | null {
  if (value === null || typeof value !== "object") return null;
  const { type, attrs } = value as { type?: unknown; attrs?: unknown };
  if (typeof type !== "string") return null;
  return {
    node: type,
    attrs: attrs !== null && typeof attrs === "object" ? storedAttrs(attrs as Attrs) : {},
  };
}

function pushText(out: InlineItem[], text: string, marks: Marks) {
  const last = out.at(-1);
  if (last?.kind === "text" && (last.marks === marks || sameValue(last.marks, marks))) {
    out[out.length - 1] = { kind: "text", text: last.text + text, marks };
  } else out.push({ kind: "text", text, marks });
}

/** Normalized inline content, with adjacent text runs of equal marks merged, as readers compare it. */
export function normalizeInline(items: readonly InlineItem[]): InlineItem[] {
  const out: InlineItem[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      if (item.text.length > 0) pushText(out, item.text, item.marks);
    } else out.push(item);
  }
  return out;
}

/** One UTF-16 unit of a text doc, as stored, with whether a reader shows it. */
export interface TextUnit {
  ch: string;
  stored: Readonly<Record<string, unknown>>;
  /** Its position in the stored text. */
  pos: number;
  /** A U+FFFC whose inline node the block's type does not show: readers and writers skip it. */
  hidden: boolean;
  /** For a shown U+FFFC with the `inline` style, the node it stands for. */
  inline?: { node: string; attrs: Attrs };
}

/**
 * Every unit of a text doc, and the one rule for which a reader hides: `readInline` reads these,
 * and every writer addresses text through them. Positions a reader counts (the editor's offsets,
 * agent-edit's units) are indexes among the units that are not hidden (`shownUnits`).
 */
export function textUnits(
  doc: LoroDoc | undefined,
  rule: NodeRule,
  shape: ShapeSchema,
): TextUnit[] {
  if (!doc) return [];
  const units: TextUnit[] = [];
  let pos = 0;
  for (const part of inText(doc, (text) => text.toDelta()) as Delta<string>[]) {
    if (part.insert === undefined) continue;
    const stored = part.attributes ?? {};
    const style = inlineStyle(stored[INLINE_STYLE]);
    const shows =
      style !== null && rule.allowsInline(style.node) && shape.node(style.node) !== undefined;
    for (let i = 0; i < part.insert.length; i++) {
      const ch = part.insert[i];
      const atom = ch === SENTINEL && style !== null;
      units.push({
        ch,
        stored,
        pos: pos++,
        hidden: atom && !shows,
        ...(atom && shows ? { inline: style } : {}),
      });
    }
  }
  return units;
}

/** The units a reader shows, in order: index `n` is the reader's offset `n`. */
export function shownUnits(
  doc: LoroDoc | undefined,
  rule: NodeRule,
  shape: ShapeSchema,
): TextUnit[] {
  return textUnits(doc, rule, shape).filter((unit) => !unit.hidden);
}
