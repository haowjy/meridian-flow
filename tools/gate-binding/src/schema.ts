import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { type DOMOutputSpec, type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";

/**
 * `buildDocumentSchema()` is structure only (no `toDOM`); the app adds DOM through TipTap. This
 * adds the same kind of DOM to the same specs, so the editor runs the real node and mark set.
 */
const nodeDom: Record<string, NodeSpec["toDOM"]> = {
  paragraph: (node) => [
    node.attrs.level ? `h${node.attrs.level}` : "p",
    { "data-block-id": node.attrs.id ?? "" },
    0,
  ],
  code_block: (node) => ["pre", { "data-block-id": node.attrs.id ?? "" }, ["code", 0]],
  image: (node) => ["img", { src: node.attrs.src, alt: node.attrs.alt ?? "" }],
  hard_break: () => ["br"],
  horizontal_rule: () => ["hr"],
  table: () => ["table", ["tbody", 0]],
  table_row: () => ["tr", 0],
  table_cell: () => ["td", 0],
  table_header: () => ["th", 0],
  jsx_leaf: () => ["pre", { class: "jsx" }, 0],
  jsx_container: () => ["div", { class: "jsx" }, 0],
  figure: (node) => ["figure", ["img", { src: node.attrs.src }]],
};

const markDom: Record<string, (mark: import("prosemirror-model").Mark) => DOMOutputSpec> = {
  strong: () => ["strong", 0],
  em: () => ["em", 0],
  code: () => ["code", 0],
  link: (mark) => ["a", { href: mark.attrs.href }, 0],
  strike: () => ["s", 0],
  suggest_ins: () => ["ins", 0],
  suggest_del: () => ["del", 0],
  comment: (mark) => ["span", { class: "comment", "data-comment-id": mark.attrs.id ?? "" }, 0],
};

export function buildEditorSchema(): Schema {
  const base = buildDocumentSchema();
  let nodes = base.spec.nodes;
  base.spec.nodes.forEach((name, spec) => {
    if (nodeDom[name]) nodes = nodes.update(name, { ...spec, toDOM: nodeDom[name] } as NodeSpec);
  });
  let marks = base.spec.marks;
  base.spec.marks.forEach((name, spec) => {
    if (markDom[name]) marks = marks.update(name, { ...spec, toDOM: markDom[name] } as MarkSpec);
  });
  return new Schema({ nodes, marks });
}
