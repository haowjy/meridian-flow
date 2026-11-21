import {
  COMMENT_MARK,
  COMMENT_STYLE_PREFIX,
  type InlineItem,
  type Marks,
  markNameOf,
  type NodeRule,
  type RoomDocs,
  readDocument,
  type ShapeBlock,
  type ShapeSchema,
  type StyleExpand,
  storedAttrs,
  type WriteOptions,
  writeDocument,
} from "@meridian/document-model";
import { Fragment, Mark, type Node, type Schema } from "prosemirror-model";

const shapes = new WeakMap<Schema, ShapeSchema>();

/**
 * The shape's view of a ProseMirror schema (design §1): which nodes are textblocks, which marks
 * and inline nodes each allows, which containers need content and which of those an empty
 * paragraph can fill, `excludes: "_"` marks, and the `configTextStyle` set (`inclusive: false` is
 * `expand: none`, any other mark `after`; `comment` takes the default, `none`). Cached per schema.
 */
export function shapeSchemaOf(schema: Schema): ShapeSchema {
  const cached = shapes.get(schema);
  if (cached) return cached;
  const rules = new Map<string, NodeRule>();
  const paragraph = schema.nodes.paragraph;
  for (const [name, type] of Object.entries(schema.nodes)) {
    const required = !type.isLeaf && !type.contentMatch.validEnd;
    rules.set(name, {
      textblock: type.isTextblock,
      required,
      fillable:
        required && paragraph !== undefined && type.contentMatch.matchType(paragraph) !== null,
      accepts: (child) =>
        schema.nodes[child] !== undefined &&
        type.contentMatch.matchType(schema.nodes[child]) !== null,
      allowsMark: (mark) =>
        schema.marks[mark] !== undefined && type.allowsMarkType(schema.marks[mark]),
      allowsInline: (node) =>
        schema.nodes[node]?.isInline === true &&
        type.contentMatch.matchType(schema.nodes[node]) !== null,
    });
  }
  const styles: Record<string, { expand: StyleExpand }> = {};
  const exclusive = new Set<string>();
  for (const [name, type] of Object.entries(schema.marks)) {
    if (type.spec.excludes === "_") exclusive.add(name);
    if (name !== COMMENT_MARK)
      styles[name] = { expand: type.spec.inclusive === false ? "none" : "after" };
  }
  const shape: ShapeSchema = {
    node: (name) => rules.get(name),
    root: schema.topNodeType.name,
    exclusiveMarks: exclusive,
    styles,
  };
  shapes.set(schema, shape);
  return shape;
}

/** A ProseMirror mark's stored style: `comment_<id>: true`, or the mark's name and attrs. */
export function storedMark(mark: Mark): [string, unknown] {
  if (mark.type.name === COMMENT_MARK && mark.attrs.id != null)
    return [`${COMMENT_STYLE_PREFIX}${String(mark.attrs.id)}`, true];
  return [mark.type.name, mark.attrs];
}

export function storedMarks(marks: readonly Mark[]): Marks {
  return Object.fromEntries(marks.map(storedMark));
}

/**
 * The marks stored styles stand for, in rank order and, within one rank (two comments), by key:
 * Loro returns styles in no particular order, and every peer must build the same marks.
 */
export function marksOf(schema: Schema, marks: Marks): readonly Mark[] {
  const out: Mark[] = [];
  for (const [key, value] of Object.entries(marks).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const name = markNameOf(key);
    const type = schema.marks[name];
    if (!type) continue;
    if (name === COMMENT_MARK && key.startsWith(COMMENT_STYLE_PREFIX))
      out.push(type.create({ id: key.slice(COMMENT_STYLE_PREFIX.length) }));
    else
      out.push(
        type.create(
          value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null,
        ),
      );
  }
  return Mark.setFrom(out);
}

/** A textblock's inline content as the shape stores it. */
export function inlineOf(node: Node): InlineItem[] {
  const out: InlineItem[] = [];
  node.forEach((child) => {
    if (child.isText)
      out.push({ kind: "text", text: child.text ?? "", marks: storedMarks(child.marks) });
    else
      out.push({
        kind: "inline",
        node: child.type.name,
        attrs: storedAttrs(child.attrs),
        marks: storedMarks(child.marks),
      });
  });
  return out;
}

/**
 * A ProseMirror document as the shape's blocks. Every block must carry a unique `id`: the editor's
 * block-id fixer gives a split or a paste theirs in the same transaction, before the binding sees
 * it, and the binding never invents one (it would pair with nothing the editor holds).
 */
export function blocksOf(doc: Node): ShapeBlock[] {
  const blocks: ShapeBlock[] = [];
  doc.forEach((node) => {
    blocks.push(blockOf(node));
  });
  return blocks;
}

function blockOf(node: Node): ShapeBlock {
  const id = node.attrs.id;
  if (typeof id !== "string" || id.length === 0)
    throw new Error(`a ${node.type.name} block has no id`);
  const attrs = storedAttrs(node.attrs);
  if (node.isTextblock)
    return { kind: "text", id, node: node.type.name, attrs, inline: inlineOf(node) };
  const children: ShapeBlock[] = [];
  node.forEach((child) => {
    children.push(blockOf(child));
  });
  return { kind: "container", id, node: node.type.name, attrs, children };
}

/** The ProseMirror document the shape's blocks stand for, in `schema`. */
export function docOf(schema: Schema, blocks: readonly ShapeBlock[]): Node {
  return schema.topNodeType.create(
    null,
    blocks.map((block) => nodeOf(schema, block)),
  );
}

export function nodeOf(schema: Schema, block: ShapeBlock): Node {
  const type = schema.nodes[block.node];
  const attrs = { ...block.attrs, id: block.id };
  if (block.kind === "container")
    return type.create(
      attrs,
      block.children.map((child) => nodeOf(schema, child)),
    );
  return type.create(attrs, inlineNodes(schema, block.inline));
}

export function inlineNodes(schema: Schema, items: readonly InlineItem[]): Fragment {
  const nodes: Node[] = [];
  for (const item of items) {
    const marks = marksOf(schema, item.marks);
    if (item.kind === "text") {
      if (item.text.length > 0) nodes.push(schema.text(item.text, marks));
    } else nodes.push(schema.nodes[item.node].create(item.attrs, null, marks));
  }
  return Fragment.fromArray(nodes);
}

/** What the editor shows for these docs: the normalized read, as a ProseMirror document. */
export function readProseMirror(docs: RoomDocs, schema: Schema): Node {
  return docOf(schema, readDocument(docs));
}

/** Write a ProseMirror document into the docs: `writeDocument` on its blocks. */
export function writeProseMirror(docs: RoomDocs, doc: Node, options?: WriteOptions) {
  return writeDocument(docs, blocksOf(doc), options);
}
