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

/** Whether this reader sees comment `id`'s body: Live's `comments`, or a draft's override of it. */
export function commentVisibility(view: StructureView): (comment: string) => boolean {
  return (comment) => {
    const body = view.value("comments", comment);
    return body !== undefined && body !== null;
  };
}

/** A textblock's text doc, normalized. A block with no text doc yet reads as empty. */
export function readInline(
  doc: LoroDoc | undefined,
  rule: NodeRule,
  shape: ShapeSchema,
  visibleComment: (comment: string) => boolean,
): InlineItem[] {
  if (!doc) return [];
  const out: InlineItem[] = [];
  for (const part of doc.getText(TEXT_KEY).toDelta() as Delta<string>[]) {
    if (part.insert === undefined) continue;
    const stored = part.attributes ?? {};
    const marks = normalizeMarks(stored, rule, shape, visibleComment);
    const inline = inlineStyle(stored[INLINE_STYLE]);
    for (const piece of inline ? [...splitSentinels(part.insert)] : [part.insert]) {
      if (piece === SENTINEL && inline) {
        if (!rule.allowsInline(inline.node) || !shape.node(inline.node)) continue;
        out.push({ kind: "inline", node: inline.node, attrs: inline.attrs, marks });
      } else pushText(out, piece, marks);
    }
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

/** Text split so each U+FFFC is its own piece. */
function* splitSentinels(text: string): Iterable<string> {
  let start = 0;
  for (let i = 0; i < text.length; i++)
    if (text[i] === SENTINEL) {
      if (i > start) yield text.slice(start, i);
      yield SENTINEL;
      start = i + 1;
    }
  if (start < text.length) yield text.slice(start);
}

function pushText(out: InlineItem[], text: string, marks: Marks) {
  const last = out.at(-1);
  if (last?.kind === "text" && sameValue(last.marks, marks)) {
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
 * Every unit of a text doc, with the same hidden rule as `readInline`. Positions a reader counts
 * (the editor's offsets, agent-edit's units) are indexes among the units that are not hidden.
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
