/**
 * read-preview-render — converts read-tool manuscript output into rendered
 * ProseMirror DOM for chat row previews.
 *
 * The read tool prefixes each rendered block line with a stable `hash|` block
 * id for agent targeting. Writers should see the manuscript instead: strip
 * those ids, parse through Meridian's canonical MDX codec and document schema,
 * then serialize the resulting ProseMirror nodes to semantic HTML. The shared
 * structural schema intentionally has no `toDOM` specs because the editor's
 * TipTap extensions normally own DOM rendering, so this module supplies the
 * small explicit node/mark map needed for read-only preview HTML.
 */
import { builtInComponents, mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { DOMSerializer, Fragment, type Mark, type Node as PMNode } from "@tiptap/pm/model";

const schema = buildDocumentSchema();
const codec = mdxCodec({
  schema,
  assetPathResolver: unresolvedAssetPathResolver,
  components: builtInComponents,
});

const NODE_TO_DOM = {
  paragraph: (node: PMNode) => ["p", alignedBlockAttrs(node), 0],
  heading: (node: PMNode) => [`h${node.attrs.level ?? 1}`, alignedBlockAttrs(node), 0],
  blockquote: () => ["blockquote", 0],
  bullet_list: () => ["ul", 0],
  ordered_list: (node: PMNode) => {
    const order = Number(node.attrs.order ?? 1);
    return order === 1 ? ["ol", 0] : ["ol", { start: order }, 0];
  },
  list_item: () => ["li", 0],
  code_block: () => ["pre", ["code", 0]],
  hard_break: () => ["br"],
  horizontal_rule: () => ["hr"],
  image: (node: PMNode) => ["img", imageAttrs(node)],
  table: (node: PMNode) => ["table", alignedBlockAttrs(node), ["tbody", 0]],
  table_row: () => ["tr", 0],
  table_header: (node: PMNode) => ["th", tableCellAttrs(node), 0],
  table_cell: (node: PMNode) => ["td", tableCellAttrs(node), 0],
  figure: (node: PMNode) => [
    "figure",
    ["img", { src: node.attrs.src ?? "", alt: node.attrs.alt ?? "" }],
    node.attrs.caption ? ["figcaption", String(node.attrs.caption)] : ["figcaption", ""],
  ],
  // MDX component nodes are not executable UI inside a read preview. Preserve
  // their children as inert semantic containers so prose around them still renders.
  jsx_leaf: (node: PMNode) => ["span", { role: "note" }, fallbackLeafText(node)],
  jsx_container: (node: PMNode) => ["div", genericContainerAttrs(node), 0],
};

const MARK_TO_DOM = {
  strong: () => ["strong", 0],
  em: () => ["em", 0],
  code: () => ["code", 0],
  strike: () => ["s", 0],
  link: (mark: Mark) => ["a", linkAttrs(mark), 0],
};

// DOMOutputSpec is a recursive tuple type; keeping the maps literal makes the
// supported preview surface auditable and the single cast keeps ProseMirror's
// constructor happy without scattering tuple assertions through the map.
const serializer = new DOMSerializer(
  NODE_TO_DOM as unknown as ConstructorParameters<typeof DOMSerializer>[0],
  MARK_TO_DOM as unknown as ConstructorParameters<typeof DOMSerializer>[1],
);

/** Drop the leading `<hash>|` block-id prefix the read tool prepends per line. */
export function stripReadHashes(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^[0-9a-f]{4,}\|/, ""))
    .join("\n");
}

/**
 * Parse read output into rendered ProseMirror DOM. Returns `null` when content
 * is empty or unparseable so callers can fall back to plain text. Must run in a
 * browser-like environment: `serializeFragment` needs a real `document`.
 */
export function renderReadFragment(content: string): DocumentFragment | HTMLElement | null {
  const markdown = stripReadHashes(content).trim();
  if (markdown.length === 0) return null;
  const { blocks } = codec.parse(markdown);
  if (blocks.length === 0) return null;
  return serializer.serializeFragment(Fragment.fromArray(blocks));
}

function imageAttrs(node: PMNode): Record<string, string> {
  const attrs = {
    src: String(node.attrs.src ?? ""),
    alt: String(node.attrs.alt ?? ""),
  };
  if (node.attrs.title) return { ...attrs, title: String(node.attrs.title) };
  return attrs;
}

function linkAttrs(mark: Mark): Record<string, string> {
  const attrs = { href: String(mark.attrs.href ?? "#") };
  if (mark.attrs.title) return { ...attrs, title: String(mark.attrs.title) };
  return attrs;
}

function tableCellAttrs(node: PMNode): Record<string, string | number> {
  const attrs: Record<string, string | number> = {};
  const styles: string[] = [];
  const alignment = node.attrs.alignment;
  if (alignment) styles.push(`text-align: ${alignment}`);
  const width = Array.isArray(node.attrs.colwidth) ? Number(node.attrs.colwidth[0]) : 0;
  if (Number.isFinite(width) && width > 0) styles.push(`width: ${width}px`);
  if (styles.length > 0) attrs.style = styles.join("; ");
  const colspan = Number(node.attrs.colspan ?? 1);
  const rowspan = Number(node.attrs.rowspan ?? 1);
  if (colspan > 1) attrs.colspan = colspan;
  if (rowspan > 1) attrs.rowspan = rowspan;
  return attrs;
}

function alignedBlockAttrs(node: PMNode): Record<string, string> {
  const align = node.attrs.align;
  return align === "center" || align === "right" ? { style: `text-align: ${align}` } : {};
}

function genericContainerAttrs(node: PMNode): Record<string, string> {
  const props = node.attrs.props;
  if (!props || typeof props !== "object") return {};
  const align = (props as Record<string, unknown>).align;
  return align === "center" || align === "right" ? { style: `text-align: ${align}` } : {};
}

function fallbackLeafText(node: PMNode): string {
  const props =
    node.attrs.props && typeof node.attrs.props === "object"
      ? (node.attrs.props as Record<string, unknown>)
      : {};
  for (const key of ["alt", "label", "title"]) {
    if (typeof props[key] === "string" && props[key].length > 0) return String(props[key]);
  }
  return String(node.attrs.name ?? "");
}
