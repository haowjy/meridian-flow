import { type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";
import { marks as basicMarks, nodes as basicNodes } from "prosemirror-schema-basic";

/** Y.XmlFragment name shared by editor Collaboration and server Yjs mirror. */
export const PROSEMIRROR_FRAGMENT_NAME = "prosemirror";

function specOnly<T extends NodeSpec | MarkSpec>(spec: T): Omit<T, "parseDOM" | "toDOM"> {
  const { parseDOM, toDOM, ...structural } = spec;
  return structural as Omit<T, "parseDOM" | "toDOM">;
}

const basicNodeDefaults = {
  doc: specOnly(basicNodes.doc),
  paragraph: specOnly(basicNodes.paragraph),
  blockquote: specOnly(basicNodes.blockquote),
  heading: specOnly(basicNodes.heading),
  text: specOnly(basicNodes.text),
  hard_break: specOnly(basicNodes.hard_break),
} satisfies Record<string, NodeSpec>;

const basicNodeOverrides = {
  code_block: {
    ...specOnly(basicNodes.code_block),
    attrs: { language: { default: null } },
  },
} satisfies Record<string, NodeSpec>;

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
} satisfies Record<string, NodeSpec>;

const basicMarkDefaults = {
  strong: specOnly(basicMarks.strong),
  em: specOnly(basicMarks.em),
} satisfies Record<string, MarkSpec>;

const customMarks = {
  code: {
    ...specOnly(basicMarks.code),
    excludes: "_",
  },
  link: {
    attrs: {
      href: { default: "" },
      title: { default: null },
    },
    inclusive: false,
  },
} satisfies Record<string, MarkSpec>;

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
