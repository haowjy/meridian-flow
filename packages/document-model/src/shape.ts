import type { LoroDoc } from "loro-crdt";

/** A block's identity: its `id` attribute, which names its structure keys and its text doc. */
export type BlockId = string;

/** The structure doc's key in a room's envelope; every other doc key is a block id. */
export const STRUCTURE_KEY = "s";

/** `s` for the structure doc, otherwise the id of the block whose text the doc holds. */
export type DocKey = string;

/** The structure doc's value maps. A fork writes only the `d.`-prefixed copies (`overrideMap`). */
export const STRUCTURE_MAPS = ["parent", "order", "node", "attrs", "comments", "pieces"] as const;
export type StructureMap = (typeof STRUCTURE_MAPS)[number];
export const overrideMap = (name: StructureMap) => `d.${name}` as const;

/**
 * What a stored map of the structure doc holds: Live's values of a structure map (`base`), or a
 * draft's overrides of one (`override`, `overrideMap`).
 */
export type MapKind = { kind: "base" | "override"; map: StructureMap };

export function mapKind(name: string): MapKind {
  return name.startsWith("d.")
    ? { kind: "override", map: name.slice(2) as StructureMap }
    : { kind: "base", map: name as StructureMap };
}

/**
 * A `pieces` key: the two blocks a write moved text between (a split, a join), smaller id first.
 * Only a draft writes it (`d.pieces`); `changedBlocks` reads the records to group changes, and a
 * press deletes those of the changes it presses (design §2).
 */
export const pieceKey = (a: BlockId, b: BlockId) => (a < b ? `${a}/${b}` : `${b}/${a}`);
export const pieceEnds = (key: string) => key.split("/", 2) as [BlockId, BlockId];

/**
 * What a structure key belongs to: for a comment body (`comments`, `d.comments`) the comment, for
 * an `attrs` key (`id/name`) its block, for a `pieces` record both its blocks; every other map is
 * keyed by block id.
 */
export const membersOf = (name: string, key: string): string[] => {
  const { map } = mapKind(name);
  return map === "attrs"
    ? [key.slice(0, key.lastIndexOf("/"))]
    : map === "pieces"
      ? pieceEnds(key)
      : [key];
};

/** The text doc's one container. */
export const TEXT_KEY = "t";

/** An inline node is one U+FFFC carrying the `inline` style, written in the same commit. */
export const SENTINEL = "￼";
export const INLINE_STYLE = "inline";

/** A comment's anchor is a style key per comment, value `true`; its body is `comments[id]`. */
export const COMMENT_MARK = "comment";
export const COMMENT_STYLE_PREFIX = "comment_";

export type Attrs = Readonly<Record<string, unknown>>;

/** A stored mark: its style key (`strong`, `comment_<id>`) and value (the mark's attrs, or `true`). */
export type Marks = Readonly<Record<string, unknown>>;

export interface CommentBody {
  body: string;
  author: string;
  resolved: boolean;
}

/** One normalized piece of a textblock: a run of text, or an inline node (one unit wide). */
export type InlineItem =
  | { kind: "text"; text: string; marks: Marks }
  | { kind: "inline"; node: string; attrs: Attrs; marks: Marks };

/**
 * A block as every reader sees it after the read normalizer (`readDocument`), and as every writer
 * hands it to `writeDocument`. `attrs` never holds `id` or a null value.
 */
export type ShapeBlock =
  | { kind: "text"; id: BlockId; node: string; attrs: Attrs; inline: readonly InlineItem[] }
  | { kind: "container"; id: BlockId; node: string; attrs: Attrs; children: readonly ShapeBlock[] };

/** What the normalizer needs to know about one node type. */
export interface NodeRule {
  /** Its content is a text doc (paragraph, code_block, jsx_leaf). */
  textblock: boolean;
  /** Its content may not be empty (table, table_row, cells, jsx_container). */
  required: boolean;
  /** Required and accepts a paragraph: with no shown child it shows an unstored empty one. */
  fillable: boolean;
  accepts(node: string): boolean;
  allowsMark(mark: string): boolean;
  allowsInline(node: string): boolean;
}

export type StyleExpand = "before" | "after" | "both" | "none";

/**
 * The schema facts the shape reads, built from a ProseMirror schema by the binding
 * (`shapeSchemaOf` in `@meridian/loro-prosemirror`), so this package has no ProseMirror at runtime.
 */
export interface ShapeSchema {
  node(name: string): NodeRule | undefined;
  /** The document node's name; its rule says whether an empty document shows an empty paragraph. */
  root: string;
  /** Marks that exclude every other (`excludes: "_"`, i.e. `code`): a run carrying one shows it alone. */
  exclusiveMarks: ReadonlySet<string>;
  /** The `configTextStyle` set: every mark but `comment`, `expand` from `inclusive`. */
  styles: Readonly<Record<string, { expand: StyleExpand }>>;
}

/**
 * Configure a doc's text styles. Loro keeps the config per doc instance and a fork does not inherit
 * it, so every doc and fork a writer creates is configured before its first mark. `comment_<id>`
 * keys and `inline` take the default, `none`.
 */
export function configureDoc(doc: LoroDoc, shape: ShapeSchema): LoroDoc {
  doc.configTextStyle(shape.styles);
  doc.configDefaultTextStyle({ expand: "none" });
  return doc;
}

/** The mark type a stored style key belongs to. */
export function markNameOf(key: string): string {
  return key.startsWith(COMMENT_STYLE_PREFIX) ? COMMENT_MARK : key;
}

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object" && !(value instanceof Uint8Array)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
        )
      : value;

/** Deep equality of stored values, independent of key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

/** `attrs` without `id` and without null or undefined values: the form the structure stores. */
export function storedAttrs(attrs: Attrs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs))
    if (key !== "id" && value !== null && value !== undefined) out[key] = value;
  return out;
}
