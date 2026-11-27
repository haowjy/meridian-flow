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

function specOnly<T extends NodeSpec | MarkSpec>(spec: T): Omit<T, "parseDOM" | "toDOM"> {
  const { parseDOM, toDOM, ...structural } = spec;
  return structural as Omit<T, "parseDOM" | "toDOM">;
}

// keep: Never add validate to align or level; bad stored values must read as themselves and fail at write boundaries
const layoutAlignAttr = { default: null };

export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

const paragraphLevelAttr = { default: null };

const nestingAttrs = {
  path: { default: null },
  kind: { default: null },
  marker: { default: null },
  start: { default: null },
  loose: { default: null },
};

const idAttr = { default: null };

const blockAttrs = { id: idAttr, ...nestingAttrs };

const basicNodeDefaults = {
  doc: specOnly(basicNodes.doc),
  text: specOnly(basicNodes.text),
  hard_break: specOnly(basicNodes.hard_break),
} satisfies Record<string, NodeSpec>;

const linkRefAttr = { default: null };

const basicNodeOverrides = {
  paragraph: {
    ...specOnly(basicNodes.paragraph),
    attrs: { align: layoutAlignAttr, level: paragraphLevelAttr, ...blockAttrs },
  },

  code_block: {
    ...specOnly(basicNodes.code_block),
    attrs: { language: { default: null }, ...blockAttrs },
  },

  // keep: Image src needs a default, not basic schema's validate: string
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

  horizontal_rule: { ...specOnly(basicNodes.horizontal_rule), attrs: blockAttrs },
} satisfies Record<string, NodeSpec>;

const customNodes = {
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
      uploadToken: { default: null },
      ref: linkRefAttr,
      ...blockAttrs,
    },
    atom: true,
    defining: true,
  },
} satisfies Record<string, NodeSpec>;

const basicMarkDefaults = {
  strong: specOnly(basicMarks.strong),
  em: specOnly(basicMarks.em),
} satisfies Record<string, MarkSpec>;

const customMarks = {
  // keep: Code mark needs excludes: _ to match TipTap's Code extension
  code: {
    ...specOnly(basicMarks.code),
    excludes: "_",
  },

  // keep: Link href needs a default, not basic schema's validate: string
  link: {
    attrs: {
      href: { default: "" },
      title: { default: null },
      ref: linkRefAttr,
    },
    inclusive: false,
  },

  strike: {},

  comment: { attrs: { id: { default: null } }, inclusive: false, excludes: "", markdown: false },
} satisfies Record<string, MarkSpec>;

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
