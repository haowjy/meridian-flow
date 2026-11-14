# @meridian/prosemirror-schema — structural contract

## Why parity matters

The server never renders TipTap DOM, but it parses, diffs, mirrors and serializes the same
Yjs documents. A server schema narrower than the editor's lets y-prosemirror updates decode on
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

- Every block node (the nine that carry nesting, plus `table_row`) has `id`, a permanent
  identity the merge, review and the Yjs writer pair blocks by. It is set once where a block
  is made and copied with the other attributes everywhere; Markdown never carries it, and a
  block read from the model's Markdown has none. Null means none recorded, which no stored
  block may be: `writeBlocks` refuses it and `insertBlocks` (the door for codec blocks) assigns
  one. `block-id.ts` holds the generator and the walkers. Adding it was also part of collab schema 3.0.0.

- `align` is `null`, `"center"` or `"right"`. There is no `"left"`: unaligned is the default,
  and a second spelling would be a ghost state the markup codec must reject. Markup carries it
  as a `Layout` wrapper, so an alignable node gains no markup until a writer aligns it.
- `image` takes no marks (MDAST has none). `uploadToken` is ephemeral Yjs-only upload identity,
  absent from Markdown and MDX. A link, image or figure `ref` is stored state only, never in
  Markdown, HTML, MDX or the DOM; `href` or `src` is the fallback spelling.
