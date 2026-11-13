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

- Lists are not nodes. Every block in the `block` group carries `path`, `kind`, `marker`,
  `start` and `loose` (all default `null`, none validated: the binding deletes an element
  the schema cannot build, so any value must read as something). `nesting.ts` is the one
  reader, `nest`, and is total: it never throws and nothing writes an attribute to repair a
  document. `numberOf` is the one ordered-number rule (0 to 999,999,999, held at the last
  number Markdown can write).

- `align` is `null`, `"center"` or `"right"`. There is no `"left"`: unaligned is the default,
  and a second spelling would be a ghost state the markup codec must reject. Markup carries it
  as a `Layout` wrapper, so an alignable node gains no markup until a writer aligns it.
- `image` takes no marks (MDAST has none). `uploadToken` is ephemeral Yjs-only upload identity,
  absent from Markdown and MDX. A link, image or figure `ref` is stored state only, never in
  Markdown, HTML, MDX or the DOM; `href` or `src` is the fallback spelling.
