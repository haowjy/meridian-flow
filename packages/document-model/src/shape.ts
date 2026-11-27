import type { LoroDoc } from "loro-crdt";

export type BlockId = string;

export const STRUCTURE_KEY = "s";

export type DocKey = string;

export const STRUCTURE_MAPS = ["parent", "order", "node", "attrs", "comments", "pieces"] as const;
export type StructureMap = (typeof STRUCTURE_MAPS)[number];
export const overrideMap = (name: StructureMap) => `d.${name}` as const;

export type MapKind = { kind: "base" | "override"; map: StructureMap };

export function mapKind(name: string): MapKind {
  return name.startsWith("d.")
    ? { kind: "override", map: name.slice(2) as StructureMap }
    : { kind: "base", map: name as StructureMap };
}

export const pieceKey = (a: BlockId, b: BlockId) => (a < b ? `${a}/${b}` : `${b}/${a}`);
export const pieceEnds = (key: string) => key.split("/", 2) as [BlockId, BlockId];

export const membersOf = (name: string, key: string): string[] => {
  const { map } = mapKind(name);
  return map === "attrs"
    ? [key.slice(0, key.lastIndexOf("/"))]
    : map === "pieces"
      ? pieceEnds(key)
      : [key];
};

export const TEXT_KEY = "t";

export const SENTINEL = "￼";
export const INLINE_STYLE = "inline";

export const COMMENT_MARK = "comment";
export const COMMENT_STYLE_PREFIX = "comment_";

export type Attrs = Readonly<Record<string, unknown>>;

export type Marks = Readonly<Record<string, unknown>>;

export interface CommentBody {
  body: string;
  author: string;
  resolved: boolean;
}

export type InlineItem =
  | { kind: "text"; text: string; marks: Marks }
  | { kind: "inline"; node: string; attrs: Attrs; marks: Marks };

export type ShapeBlock =
  | { kind: "text"; id: BlockId; node: string; attrs: Attrs; inline: readonly InlineItem[] }
  | { kind: "container"; id: BlockId; node: string; attrs: Attrs; children: readonly ShapeBlock[] };

export interface NodeRule {
  textblock: boolean;
  required: boolean;
  fillable: boolean;
  accepts(node: string): boolean;
  allowsMark(mark: string): boolean;
  allowsInline(node: string): boolean;
}

export type StyleExpand = "before" | "after" | "both" | "none";

export interface ShapeSchema {
  node(name: string): NodeRule | undefined;
  root: string;
  exclusiveMarks: ReadonlySet<string>;
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

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

export function storedAttrs(attrs: Attrs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs))
    if (key !== "id" && value !== null && value !== undefined) out[key] = value;
  return out;
}
