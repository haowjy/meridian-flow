// A render-capable derivative of the shared `documentNodes` schema. The
// canonical specs in `@meridian/prosemirror-schema` strip parseDOM/toDOM (those
// belong to the editor layer, normally TipTap extensions). For a throwaway
// demo we add minimal DOM serializers here so prosemirror-view can render the
// live Y.Doc.
//
// IMPORTANT: this schema is structurally identical to `buildDocumentSchema()`
// — same node names, attrs, content models, marks. Only DOM is added. That
// lets y-prosemirror map between the live Y.XmlFragment and the EditorView.
import { documentMarks, documentNodes } from "@meridian/prosemirror-schema";
import { type DOMOutputSpec, type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";

function withDom<T extends NodeSpec | MarkSpec>(
  spec: T,
  toDOM: T["toDOM"],
  parseDOM?: T["parseDOM"],
): T {
  return { ...spec, toDOM, parseDOM } as T;
}

const renderNodes: Record<string, NodeSpec> = {
  doc: documentNodes.doc,
  text: documentNodes.text,

  paragraph: withDom(documentNodes.paragraph, () => ["p", 0], [{ tag: "p" }]),

  heading: withDom(
    documentNodes.heading,
    (node) => [`h${node.attrs.level}`, 0],
    [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
  ),

  blockquote: withDom(documentNodes.blockquote, () => ["blockquote", 0], [{ tag: "blockquote" }]),

  code_block: withDom(documentNodes.code_block, () => ["pre", ["code", 0]], [
    { tag: "pre", preserveWhitespace: "full" },
  ]),

  horizontal_rule: withDom(documentNodes.horizontal_rule, () => ["hr"], [{ tag: "hr" }]),

  hard_break: withDom(documentNodes.hard_break, () => ["br"], [{ tag: "br" }]),

  bullet_list: withDom(documentNodes.bullet_list, () => ["ul", 0], [{ tag: "ul" }]),
  ordered_list: withDom(
    documentNodes.ordered_list,
    (node) =>
      node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: node.attrs.order as number }, 0],
    [{ tag: "ol" }],
  ),
  list_item: withDom(documentNodes.list_item, () => ["li", 0], [{ tag: "li" }]),

  image: withDom(
    documentNodes.image,
    (node) => [
      "img",
      {
        src: node.attrs.src,
        alt: node.attrs.alt ?? undefined,
        title: node.attrs.title ?? undefined,
      },
    ],
    [{ tag: "img[src]" }],
  ),

  // jsx_leaf / jsx_container: real TipTap node-views land in Step 9.
  // For the demo we render a placeholder so the structural node is visible
  // and clearly tagged as not-yet-implemented.
  jsx_leaf: withDom(documentNodes.jsx_leaf, (node) => [
    "div",
    {
      class: "jsx-placeholder jsx-placeholder--leaf",
      "data-jsx-name": String(node.attrs.name ?? ""),
    },
    `<${String(node.attrs.name ?? "Component")} /> (jsx_leaf placeholder — node-view pending Step 9)`,
  ]),

  jsx_container: withDom(
    documentNodes.jsx_container,
    (node): DOMOutputSpec => [
      "div",
      {
        class: "jsx-placeholder jsx-placeholder--container",
        "data-jsx-name": String(node.attrs.name ?? ""),
      },
      [
        "div",
        { class: "jsx-placeholder__label" },
        `<${String(node.attrs.name ?? "Component")}> (jsx_container placeholder — node-view pending Step 9)`,
      ],
      ["div", { class: "jsx-placeholder__body" }, 0],
    ],
  ),

  figure: withDom(documentNodes.figure, (node) => [
    "figure",
    { class: "figure-placeholder" },
    ["img", { src: node.attrs.src, alt: node.attrs.alt ?? undefined }],
    ["figcaption", String(node.attrs.caption ?? "")],
  ]),
};

const renderMarks: Record<string, MarkSpec> = {
  strong: withDom(documentMarks.strong, () => ["strong", 0], [{ tag: "strong" }, { tag: "b" }]),
  em: withDom(documentMarks.em, () => ["em", 0], [{ tag: "em" }, { tag: "i" }]),
  code: withDom(documentMarks.code, () => ["code", 0], [{ tag: "code" }]),
  link: withDom(
    documentMarks.link,
    (mark) => [
      "a",
      { href: mark.attrs.href as string, title: (mark.attrs.title ?? undefined) as string },
      0,
    ],
    [{ tag: "a[href]" }],
  ),
};

export function buildRenderSchema(): Schema {
  return new Schema({ nodes: renderNodes, marks: renderMarks });
}
