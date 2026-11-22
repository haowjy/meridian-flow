import type { Delta, LoroDoc } from "loro-crdt";
import type { RoomDocs } from "./room-docs.js";
import {
  type Attrs,
  type BlockId,
  COMMENT_STYLE_PREFIX,
  INLINE_STYLE,
  type InlineItem,
  type Marks,
  markNameOf,
  type NodeRule,
  overrideMap,
  SENTINEL,
  type ShapeBlock,
  type ShapeSchema,
  sameValue,
  storedAttrs,
  TEXT_KEY,
} from "./shape.js";
import { StructureView } from "./structure.js";

/**
 * The id every peer gives the unstored empty paragraph of a cell, container or document with no
 * shown block, so two peers typing into it first make one block (`/empty` for the document).
 */
export const emptyParagraphId = (parent: BlockId | null) => `${parent ?? ""}/empty`;

const emptyParagraph = (parent: BlockId | null): ShapeBlock => ({
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
 */
export function readDocument(docs: RoomDocs): ShapeBlock[] {
  return readBlocks(docs, new StructureView(docs.structure, docs.draft, docs.shape));
}

export function readBlocks(docs: RoomDocs, view: StructureView): ShapeBlock[] {
  const shape = docs.shape;
  const visibleComments = commentVisibility(view);
  const one = (id: BlockId): ShapeBlock => {
    const node = view.node(id) as string;
    const rule = shape.node(node) as NodeRule;
    const attrs = view.attrs(id);
    if (rule.textblock)
      return {
        kind: "text",
        id,
        node,
        attrs,
        inline: readInline(docs.textOf(id), rule, shape, visibleComments),
      };
    const children = view.children(id).map(one);
    if (children.length === 0 && rule.fillable) children.push(emptyParagraph(id));
    return { kind: "container", id, node, attrs, children };
  };
  const blocks = view.children(null).map(one);
  if (blocks.length === 0 && shape.node(shape.root)?.fillable) blocks.push(emptyParagraph(null));
  return blocks;
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
  return {
    value(name, key) {
      const override = docs.draft ? docs.structure.getMap(overrideMap(name)).get(key) : undefined;
      return override === undefined ? docs.structure.getMap(name).get(key) : override;
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
  for (const part of doc.getText(TEXT_KEY).toDelta() as Delta<string>[]) {
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
