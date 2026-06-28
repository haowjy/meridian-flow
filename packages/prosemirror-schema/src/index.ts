/**
 * Purpose: Defines Meridian's shared ProseMirror document node/mark specs and builds the runtime Schema from them.
 * Why independent: These structural specs must be identical in server adapters and the frontend editor to keep y-prosemirror documents safe, so they live as a shared primitive instead of domain code.
 * MULTIPLE PURPOSES: structural node specs, structural mark specs, schema construction, and shared Yjs collaboration protocol constants.
 */
import { uint32 } from "lib0/random";
import { type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";
import { marks as basicMarks, nodes as basicNodes } from "prosemirror-schema-basic";
import { Doc } from "yjs";

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
    marks: "",
    attrs: {
      src: { default: "" },
      alt: { default: null },
      title: { default: null },
    },
    draggable: true,
  },

  // Scene breaks / thematic breaks — round-trip as markdown `---`
  horizontal_rule: specOnly(basicNodes.horizontal_rule),
} satisfies Record<string, NodeSpec>;

// ─── Nodes NOT in basic (defined from scratch) ──────────────────────

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
    attrs: { checked: { default: null } },
  },

  // GFM table cells are single-line inline markdown; one paragraph is the
  // structural representation TipTap table commands expect. colspan/rowspan/
  // colwidth stay because prosemirror-tables editing commands use them internally.
  table: {
    content: "table_row+",
    group: "block",
    tableRole: "table",
    isolating: true,
  },

  table_row: {
    content: "(table_header | table_cell)+",
    tableRole: "row",
  },

  table_header: {
    content: "paragraph",
    tableRole: "header_cell",
    isolating: true,
    attrs: {
      alignment: { default: null },
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
    },
  },

  table_cell: {
    content: "paragraph",
    tableRole: "cell",
    isolating: true,
    attrs: {
      alignment: { default: null },
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
    },
  },

  jsx_leaf: {
    attrs: { name: {}, props: { default: {} } },
    content: "text*",
    group: "block",
    code: true,
  },

  jsx_container: {
    attrs: { name: {}, props: { default: {} } },
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
    },
    atom: true,
    defining: true,
    // Not draggable: in-place drag-reorder re-binds block hashes (y-prosemirror
    // reconciles by slot). Move figures via delete+insert instead — see the
    // editor .context/TODO.md and agent-edit .context/CONTEXT.md reorder policy.
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

  strike: {},
} satisfies Record<string, MarkSpec>;

// ─── Exports ────────────────────────────────────────────────────────

/**
 * Bump when the ProseMirror/TipTap schema or Yjs encoding changes; bumping
 * invalidates client IndexedDB caches and flags server-persisted docs built on
 * the old version. Lives here because this package owns the schema shape the
 * version tracks — client and server must import the same value.
 */
export const COLLAB_SCHEMA_VERSION = 4;

export const PROSEMIRROR_FRAGMENT_NAME = "prosemirror";

/**
 * Reserved clientID band [0, RESERVED_CLIENT_ID_MAX] is owned by server-authored
 * Yjs writer streams (e.g. agent-edit reversal). Human/agent docs must never draw a
 * clientID in this band, and inbound updates carrying structs from it are rejected at
 * ingest. This is a Meridian convention — Yjs has no native reserved-range concept; the
 * Yjs invariant we rely on is that one clientID is owned by exactly one live writer.
 */
export const RESERVED_CLIENT_ID_MAX = 999;
/** The agent-edit reversal/mutation writer slot within the reserved band. */
export const AGENT_EDIT_UNDO_CLIENT_ID = 999;
export const isReservedClientId = (clientId: number): boolean => clientId <= RESERVED_CLIENT_ID_MAX;

/** Construct a collab Y.Doc whose clientID is guaranteed outside the reserved band. */
export function createCollabYDoc(options?: ConstructorParameters<typeof Doc>[0]): Doc {
  const doc = new Doc(options);
  while (isReservedClientId(doc.clientID)) {
    doc.clientID = uint32();
  }
  return doc;
}

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
