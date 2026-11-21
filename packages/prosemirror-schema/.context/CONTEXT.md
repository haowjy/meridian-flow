# @meridian/prosemirror-schema — structural contract

## Why parity matters

The server never renders TipTap DOM, but it parses, diffs, mirrors and serializes the same
Yjs documents. A server schema narrower than the editor's lets the shared y-tiptap binding decode on
one side and fail on the other, so this package follows the editor's structural surface.

## Contracts

- `CollabSchemaVersion` strings are the boundary form; packed integers are SQL-only and
  adapters pack or unpack them.
- `collabSchemaKeyTag()` partitions persisted client state by major and minor, not patch.
- The WebSocket carrier is one `meridian.collab.{major}.{minor}.{patch}` subprotocol grammar:
  the client offers exactly one token, and absent, zero or multiple matches resolve to the
  `0.0.0` sentinel.

## Surface decisions

- Lists and quotes are not nodes. Every block in the `block` group carries `path`, `kind`, `marker`,
  `start` and `loose` (all default `null`, none validated: the binding deletes an element
  the schema cannot build, so any value must read as something). `nesting.ts` is the one
  reader, `nest`, and is total: it never throws and nothing writes an attribute to repair a
  document. `numberOf` is the one ordered-number rule (0 to 999,999,999, held at the last
  number Markdown can write). `detach` and `landingBase` are the rules for blocks that
  leave their place: a copied or moved run drops the levels outside it, and a moved run
  keeps its depth, at most one level under the block it lands below. `sharedSteps` is how many
  leading steps a run of blocks sits in together, which is where a quote around them goes.
  Removing the list and quote nodes was part of collab schema 3.0.0.

- Every block node, table row and table cell (`table_cell` and `table_header`) has an `id`
  attribute. This permanent identity lets the merge, review and Yjs writer match the same
  block across edits. It is set once where a block is made and copied with its other
  attributes on a move; a copied block gets a new ID. Markdown never carries IDs, so content
  parsed from the model's Markdown has the schema's default, null. Stored blocks must have
  non-null IDs: `insertBlocks` assigns them when codec blocks enter storage, and `writeBlocks`
  rejects a block without one. `block-id.ts` holds the generator and walkers.
  Rows and content blocks gained IDs in collab schema 3.0.0; cells gained them in 3.1.0.
  Before using 3.1.0 with older tables, run `pnpm db:reset` from the checkout that owns the
  dev database. This deletes that database's data. There is no backfill, and the minor version
  does not stop the server from reading older stored documents.

- Suggestion mode (3.2.0 and 3.3.0) adds the `suggest_ins`, `suggest_del` and `comment` marks and
  the `sug` and `sugAttrs` block attributes; `@meridian/suggestions` owns what they mean. The
  marks may overlap (`excludes: ""`), so the binding stores each under `yjsMarkKey`; a server
  writer that keys a mark by its bare name overwrites another draft's mark on the same text.
  A mark holds only `{ id, draft }`: each changed word carries it twice and history keeps it for
  good. `sugAttrs` is one record to ProseMirror and one Yjs element attribute per layer
  (`sugAttrs--<layer id>`, `layer-key.ts`): a schema can't declare a key per layer, and the
  binding drops an undeclared key, so every element ↔ node conversion folds or expands by
  `layer-key.ts`, and the y-tiptap patch carries a copy of the rule. Who wrote a change lives once per change in the Y.Doc's `suggestion_authors` map
  (agent-edit's `stored-suggestions.ts`), outside the schema.

- `align` is `null`, `"center"` or `"right"`. There is no `"left"`: unaligned is the default,
  and a second spelling would be a ghost state the markup codec must reject. Markup carries it
  as a `Layout` wrapper, so an alignable node gains no markup until a writer aligns it.
- `image` takes no marks (MDAST has none). `uploadToken` is ephemeral Yjs-only upload identity,
  absent from Markdown and MDX. A link, image or figure `ref` is stored state only, never in
  Markdown, HTML, MDX or the DOM; `href` or `src` is the fallback spelling.
