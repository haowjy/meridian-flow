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
 * A fork's record of the overrides a press settled (design §2, "A press settles an override by a
 * record"): `d.settled["<map>/<key>"]` holds the override value the press read, and the override
 * reads as absent while it still holds that value. A press sets entries and never writes an
 * override's key, so a tab's write the press did not read stays a pending change; its Undo
 * deletes them; every writer of an override deletes the key's entry in the same commit.
 */
export const SETTLED_MAP = "d.settled";
export const settledKey = (name: StructureMap, key: string) => `${name}/${key}`;
/** The override a `d.settled` key names: its map, and its key there. */
export const settledTarget = (key: string): [StructureMap, string] => {
  const slash = key.indexOf("/");
  return [key.slice(0, slash) as StructureMap, key.slice(slash + 1)];
};

/**
 * Whether a draft's override holding `raw` is in force, with its `d.settled` entry `entry`: it is
 * set, and not the value a press settled it at. One not in force reads Live's value.
 */
export const inForce = (raw: unknown, entry: unknown) =>
  raw !== undefined && !sameValue(entry, raw);

/**
 * What a stored map of the structure doc holds: Live's values of a structure map (`base`), a
 * draft's overrides of one (`override`, `overrideMap`), or a press's settling of overrides
 * (`settled`, `SETTLED_MAP`).
 */
export type MapKind = { kind: "base" | "override"; map: StructureMap } | { kind: "settled" };

export function mapKind(name: string): MapKind {
  if (name === SETTLED_MAP) return { kind: "settled" };
  return name.startsWith("d.")
    ? { kind: "override", map: name.slice(2) as StructureMap }
    : { kind: "base", map: name as StructureMap };
}

/**
 * A `pieces` key: the two blocks one write moved text between (a split, a join), smaller id first,
 * then the write that says so (`stamp`: its peer and that peer's counter in the structure doc). A
 * key per write, so recording a pair again always writes, and a deletion of the keys a copy read
 * never takes a record made since. Only a draft writes it (`d.pieces`). `changedBlocks` reads the
 * records to group changes; a press settles those of the changes it settles (`d.settled`, as any
 * override), and `retirePieces` deletes those no pending change needs, inside a draft's write
 * (design §2).
 */
export const pieceKey = (a: BlockId, b: BlockId, stamp: string) =>
  a < b ? `${a}/${b}/${stamp}` : `${b}/${a}/${stamp}`;
export const pieceEnds = (key: string) => key.split("/", 2) as [BlockId, BlockId];

/**
 * What a structure key belongs to: for a comment body (`comments`, `d.comments`) the comment, for
 * an `attrs` key (`id/name`) its block, for a `pieces` record both its blocks, for a `d.settled`
 * entry what its override belongs to; every other map is keyed by block id.
 */
export const membersOf = (name: string, key: string): string[] => {
  const kind = mapKind(name);
  if (kind.kind === "settled") {
    const [map, target] = settledTarget(key);
    return membersOf(map, target);
  }
  return kind.map === "attrs"
    ? [key.slice(0, key.lastIndexOf("/"))]
    : kind.map === "pieces"
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
