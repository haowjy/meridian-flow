/**
 * Meridian's shared ProseMirror document node and mark specs, and the Schema built from them. The
 * server and the editor must read documents with the same specs, so they live here.
 */
import { type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";
import { marks as basicMarks, nodes as basicNodes } from "prosemirror-schema-basic";

export type { CollabSchemaVersion } from "./collab-schema-version.js";
export {
  COLLAB_SCHEMA_VERSION,
  cmpMajorMinor,
  collabSchemaKeyTag,
  formatCollabSchemaVersion,
  headAdmitsClient,
  packCollabSchemaVersion,
  parseCollabSchemaVersion,
  serverServesHead,
  unpackCollabSchemaVersion,
} from "./collab-schema-version.js";

/**
 * Strip parseDOM/toDOM from an upstream spec. Our package exports only
 * structural specs (content, group, attrs, etc.) — DOM serialization is
 * handled by the editor layer (TipTap extensions).
 */
function specOnly<T extends NodeSpec | MarkSpec>(spec: T): Omit<T, "parseDOM" | "toDOM"> {
  const { parseDOM, toDOM, ...structural } = spec;
  return structural as Omit<T, "parseDOM" | "toDOM">;
}

/**
 * Block alignment is a wire-level Layout wrapper, not a schema node. No `validate` on this or
 * `level` (prosemirror-model runs `validate` inside `create`): a bad value must read as itself and
 * fail where Flow writes (the codec, paste parsers), never where it reads.
 */
const layoutAlignAttr = { default: null };

/** The heading levels a paragraph's `level` may hold; every surface that offers a level reads this. */
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

const paragraphLevelAttr = { default: null };

/**
 * Where a block sits in its quotes and lists (`nest`, in `nesting.ts`, reads them). No
 * `validate`: a bad value must read as something instead of failing.
 */
const nestingAttrs = {
  path: { default: null },
  kind: { default: null },
  marker: { default: null },
  start: { default: null },
  loose: { default: null },
};

/**
 * A block's permanent identity (`block-id.ts`): set once where the block is made, copied with
 * its other attributes everywhere, and never shown in Markdown. Null means none recorded.
 */
const idAttr = { default: null };

/** The attributes of a node that is a block: its identity and its nesting. */
const blockAttrs = { id: idAttr, ...nestingAttrs };

// ─── Nodes from prosemirror-schema-basic (used as-is) ───────────────
const basicNodeDefaults = {
  doc: specOnly(basicNodes.doc),
  text: specOnly(basicNodes.text),
  hard_break: specOnly(basicNodes.hard_break),
} satisfies Record<string, NodeSpec>;

/**
 * The stable target of an internal link, `image` or `figure` source: `doc:<id>`
 * or `ahead:<id>` (`@meridian/contracts` `document-ref.ts`), null for external,
 * contextual and `asset:` sources. Stored state only: no serializer, DOM
 * renderer or wire format ever emits or reads it; every read spells the
 * target's current path from it.
 */
const linkRefAttr = { default: null };

// ─── Nodes from basic, customized ───────────────────────────────────
const basicNodeOverrides = {
  // A heading is a paragraph with a level (null is body text, 1..6 a heading).
  // Retyping a block then edits its attributes in place, so concurrent typing and
  // anchors in it survive; a separate node name would rebuild it.
  paragraph: {
    ...specOnly(basicNodes.paragraph),
    attrs: { align: layoutAlignAttr, level: paragraphLevelAttr, ...blockAttrs },
  },

  // basic's code_block lacks language attr — spread and add it
  code_block: {
    ...specOnly(basicNodes.code_block),
    attrs: { language: { default: null }, ...blockAttrs },
  },

  // basic's image uses `validate: "string"` on src — we need `default: ""`.
  // `uploadToken` names a slot some browser is filling right now: whoever starts
  // an upload writes it, a ProseMirror move copies it with the node, the landing
  // clears it, and no serializer emits it. It is what lets a peer tell "someone
  // is uploading this" from "this was abandoned" without any percent on the wire.
  // `width` is the display size the writer dragged the picture to, in CSS
  // pixels. Null is "the file's own size, capped by the column" — the state
  // every untouched picture is in, and what keeps its wire form `![alt](src)`.
  image: {
    inline: true,
    group: "inline",
    marks: "",
    attrs: {
      src: { default: "" },
      alt: { default: null },
      title: { default: null },
      uploadToken: { default: null },
      width: { default: null },
      ref: linkRefAttr,
    },
    draggable: true,
  },

  // Scene breaks / thematic breaks — round-trip as markdown `---`
  horizontal_rule: { ...specOnly(basicNodes.horizontal_rule), attrs: blockAttrs },
} satisfies Record<string, NodeSpec>;

// ─── Nodes NOT in basic (defined from scratch) ──────────────────────

const customNodes = {
  // Cells are isolating mini-documents: any block that belongs in the manuscript
  // can also belong in a cell. colspan/rowspan/colwidth stay because
  // prosemirror-tables editing commands use them internally.
  table: {
    attrs: { align: layoutAlignAttr, ...blockAttrs },
    content: "table_row+",
    group: "block",
    tableRole: "table",
    isolating: true,
  },

  table_row: {
    attrs: { id: idAttr },
    content: "(table_header | table_cell)+",
    tableRole: "row",
  },

  table_header: {
    content: "block+",
    tableRole: "header_cell",
    isolating: true,
    attrs: {
      id: idAttr,
      alignment: { default: null },
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
    },
  },

  table_cell: {
    content: "block+",
    tableRole: "cell",
    isolating: true,
    attrs: {
      id: idAttr,
      alignment: { default: null },
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
    },
  },

  jsx_leaf: {
    attrs: { name: {}, props: { default: {} }, ...blockAttrs },
    content: "text*",
    group: "block",
    code: true,
  },

  jsx_container: {
    attrs: { name: {}, props: { default: {} }, ...blockAttrs },
    content: "block+",
    group: "block",
  },

  figure: {
    group: "block",
    attrs: {
      src: { default: "" },
      alt: { default: null },
      label: { default: null },
      caption: { default: "" },
      // Replace aims an upload at an existing figure, so a figure holds the same
      // in-flight slot identity as an `image`.
      uploadToken: { default: null },
      ref: linkRefAttr,
      ...blockAttrs,
    },
    atom: true,
    defining: true,
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
      ref: linkRefAttr,
    },
    inclusive: false,
  },

  strike: {},

  // A comment's anchor; its body lives outside the document.
  // `markdown: false`: Markdown cannot write it, so a model's write, planned in Markdown, leaves it
  // alone, except that on words the model replaces it moves onto the replacement (`lowerBlock`).
  comment: { attrs: { id: { default: null } }, inclusive: false, excludes: "", markdown: false },
} satisfies Record<string, MarkSpec>;

// ─── Exports ────────────────────────────────────────────────────────

export * from "./block-id.js";
export * from "./empty-document.js";
export * from "./nesting.js";

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
