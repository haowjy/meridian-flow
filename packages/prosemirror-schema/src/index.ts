/**
 * Purpose: Defines Meridian's shared ProseMirror document node/mark specs and builds the runtime Schema from them.
 * Why independent: These structural specs must be identical in server adapters and the frontend editor to keep y-prosemirror documents safe, so they live as a shared primitive instead of domain code.
 * MULTIPLE PURPOSES: structural node specs, structural mark specs, and schema construction.
 */
import { type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";
import { marks as basicMarks, nodes as basicNodes } from "prosemirror-schema-basic";

/**
 * Strip parseDOM/toDOM from an upstream spec. Our package exports only
 * structural specs (content, group, attrs, etc.) — DOM serialization is
 * handled by the editor layer (TipTap extensions).
 */
function specOnly<T extends NodeSpec | MarkSpec>(spec: T): Omit<T, "parseDOM" | "toDOM"> {
  const { parseDOM, toDOM, ...structural } = spec;
  return structural as Omit<T, "parseDOM" | "toDOM">;
}

// ─── Nodes from prosemirror-schema-basic (used as-is) ───────────────
const basicNodeDefaults = {
  doc: specOnly(basicNodes.doc),
  paragraph: specOnly(basicNodes.paragraph),
  blockquote: specOnly(basicNodes.blockquote),
  heading: specOnly(basicNodes.heading),
  text: specOnly(basicNodes.text),
  hard_break: specOnly(basicNodes.hard_break),
} satisfies Record<string, NodeSpec>;

// ─── Nodes from basic, customized ───────────────────────────────────
const basicNodeOverrides = {
  // basic's code_block lacks language attr — spread and add it
  code_block: {
    ...specOnly(basicNodes.code_block),
    attrs: { language: { default: null } },
  },

  // basic's image uses `validate: "string"` on src — we need `default: ""`
  image: {
    inline: true,
    group: "inline",
    attrs: {
      src: { default: "" },
      alt: { default: null },
      title: { default: null },
    },
    draggable: true,
  },
} satisfies Record<string, NodeSpec>;

// TODO: horizontal_rule support — not yet included from prosemirror-schema-basic

// ─── Nodes NOT in basic (defined from scratch) ──────────────────────

const tableCellAttrs = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null },
} satisfies NodeSpec["attrs"];

const customNodes = {
  bullet_list: {
    attrs: { tight: { default: false } },
    content: "list_item+",
    group: "block",
  },

  ordered_list: {
    attrs: { order: { default: 1 }, tight: { default: false } },
    content: "list_item+",
    group: "block",
  },

  list_item: {
    content: "paragraph block*",
    defining: true,
  },

  table: {
    content: "table_row+",
    group: "block",
    isolating: true,
  },

  table_row: {
    content: "(table_cell | table_header)+",
  },

  table_cell: {
    attrs: tableCellAttrs,
    content: "inline*",
    isolating: true,
  },

  table_header: {
    attrs: tableCellAttrs,
    content: "inline*",
    isolating: true,
  },

  // TODO: LaTeX math rendering — see docs/kb/decisions/editor-math.md
  math_display: {
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
  },

  // TODO: MyST figure directives — see docs/kb/decisions/editor-figures.md
  figure: {
    group: "block",
    attrs: {
      src: { default: "" },
      alt: { default: null },
      label: { default: null },
      caption: { default: "" },
    },
    atom: true,
    defining: true,
    draggable: true,
  },
} satisfies Record<string, NodeSpec>;

// ─── Marks ──────────────────────────────────────────────────────────

// Marks from basic that match (used as-is)
const basicMarkDefaults = {
  strong: specOnly(basicMarks.strong),
  em: specOnly(basicMarks.em),
} satisfies Record<string, MarkSpec>;

// Marks we customize
const customMarks = {
  // basic's code mark lacks `excludes: "_"` — TipTap's Code extension adds it,
  // so the server schema must match
  code: {
    ...specOnly(basicMarks.code),
    excludes: "_",
  },

  // basic's link uses `validate: "string"` on href — we need `default: ""`
  link: {
    attrs: {
      href: { default: "" },
      title: { default: null },
    },
    inclusive: false,
  },
} satisfies Record<string, MarkSpec>;

// ─── Exports ────────────────────────────────────────────────────────

export const PROSEMIRROR_FRAGMENT_NAME = "prosemirror";

export const documentNodes = {
  ...basicNodeDefaults,
  ...basicNodeOverrides,
  ...customNodes,
} satisfies Record<string, NodeSpec>;

export const documentMarks = {
  ...basicMarkDefaults,
  ...customMarks,
} satisfies Record<string, MarkSpec>;

export function buildDocumentSchema(): Schema {
  return new Schema({ nodes: documentNodes, marks: documentMarks });
}
