/**
 * Purpose: Defines Meridian's shared ProseMirror document node/mark specs and builds the runtime Schema from them.
 * Why independent: These structural specs must be identical in server adapters and the frontend editor to keep y-prosemirror documents safe, so they live as a shared primitive instead of domain code.
 * MULTIPLE PURPOSES: structural node specs, structural mark specs, schema construction, and shared Yjs collaboration protocol constants.
 */
import { uint32 } from "lib0/random";
import { type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";
import { marks as basicMarks, nodes as basicNodes } from "prosemirror-schema-basic";
import { Doc, decodeStateVector, encodeStateVector } from "yjs";

export type { CollabSchemaVersion } from "./collab-schema-version.js";
export {
  COLLAB_SCHEMA_VERSION,
  clientSchemaVersionFromSubprotocolHeader,
  cmpMajorMinor,
  collabSchemaKeyTag,
  formatCollabSchemaSubprotocol,
  formatCollabSchemaVersion,
  headAdmitsClient,
  packCollabSchemaVersion,
  parseCollabSchemaVersion,
  selectCollabSchemaSubprotocol,
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
 * `level`: the binding deletes a Yjs element the schema cannot build (prosemirror-model runs
 * `validate` inside `create`), so a bad value must read as itself and fail where Flow writes
 * (the codec, paste parsers), never where it reads.
 */
const layoutAlignAttr = { default: null };

/** The heading levels a paragraph's `level` may hold; every surface that offers a level reads this. */
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

const paragraphLevelAttr = { default: null };

/**
 * Where a block sits in its quotes and lists (`nest`, in `nesting.ts`, reads them). No
 * `validate`: the binding deletes an element the schema cannot build, so a bad value must
 * read as something instead of failing.
 */
const nestingAttrs = {
  path: { default: null },
  kind: { default: null },
  marker: { default: null },
  start: { default: null },
  loose: { default: null },
};

/** The names of the nesting attributes: what moves a block's marker, indent and bar. */
export const NESTING_ATTRS = Object.keys(nestingAttrs);

/**
 * A block's permanent identity (`block-id.ts`): set once where the block is made, copied with
 * its other attributes everywhere, and never shown in Markdown. Null means none recorded.
 */
const idAttr = { default: null };

/**
 * A Work's suggestions on the block itself (a new, deleted, split or retyped block), as the JSON
 * of `@meridian/suggestions`'s marks: the Yjs binding keeps a block's attributes, not its marks.
 */
const suggestionAttr = { default: null };

/** The attributes of a node that is a block: its identity, its nesting and its suggestions. */
const blockAttrs = { id: idAttr, ...nestingAttrs, suggestion: suggestionAttr };

/** What lets a block hold suggestion marks while `@meridian/suggestions` works on it. */
const SUGGESTION_MARK_NAMES = "insertion deletion modification blockBoundarySuggestion";

// ─── Nodes from prosemirror-schema-basic (used as-is) ───────────────
const basicNodeDefaults = {
  doc: { ...specOnly(basicNodes.doc), marks: SUGGESTION_MARK_NAMES },
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
  // Retyping a block then edits its Yjs element in place, so concurrent typing,
  // authorship and anchors in it survive; a separate node name would rebuild it.
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
    marks: SUGGESTION_MARK_NAMES,
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
    marks: SUGGESTION_MARK_NAMES,
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
    marks: SUGGESTION_MARK_NAMES,
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
      ref: linkRefAttr,
    },
    inclusive: false,
  },

  strike: {},
} satisfies Record<string, MarkSpec>;

// A Work's suggestion inside the live document. Names and the `id`, `type`, `attrName`,
// `previousValue` and `newValue` attributes are `prosemirror-suggest-changes`'s, which finds
// the marks by name; `work`, `chat`, `turn` and `by` say whose suggestion it is.
const suggester = {
  work: { default: null },
  chat: { default: null },
  turn: { default: null },
  by: { default: null },
};
const suggestionMarks = {
  insertion: {
    attrs: { id: {}, ...suggester },
    inclusive: false,
    excludes: "deletion modification insertion",
  },
  deletion: {
    attrs: { id: {}, ...suggester },
    inclusive: false,
    excludes: "insertion modification deletion",
  },
  modification: {
    attrs: {
      id: {},
      type: {},
      attrName: { default: null },
      previousValue: { default: null },
      newValue: { default: null },
      ...suggester,
    },
    inclusive: false,
    excludes: "deletion insertion",
  },
  blockBoundarySuggestion: {
    attrs: { id: { default: null }, type: { default: null }, ...suggester },
    inclusive: false,
  },
} satisfies Record<string, MarkSpec>;

// ─── Exports ────────────────────────────────────────────────────────

export * from "./block-id.js";
export * from "./empty-document.js";
export * from "./nesting.js";
export { PROSEMIRROR_FRAGMENT_NAME } from "./protocol.js";

/**
 * Reserved clientID band [0, RESERVED_CLIENT_ID_MAX] is owned by server-authored
 * Yjs writer streams. Human/agent docs must never draw a
 * clientID in this band, and inbound updates carrying structs from it are rejected at
 * ingest. This is a Meridian convention — Yjs has no native reserved-range concept; the
 * Yjs invariant we rely on is that one clientID is owned by exactly one live writer.
 */
export const RESERVED_CLIENT_ID_MAX = 999;
/** Whether a client belongs to the server-reserved ingest band. */
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
  ...suggestionMarks,
} satisfies Record<string, MarkSpec>;

export function buildDocumentSchema(): Schema {
  return new Schema({ nodes: documentNodes, marks: documentMarks });
}

/** Allocate independent author identity, excluding every client already held by the document. */
export function allocateDocumentClient(
  doc: Doc,
  excluded: ReadonlySet<number> = new Set(),
): number {
  const used = decodeStateVector(encodeStateVector(doc));
  let client: number;
  do {
    client = uint32();
  } while (
    isReservedClientId(client) ||
    client === doc.clientID ||
    used.has(client) ||
    excluded.has(client)
  );
  return client;
}
