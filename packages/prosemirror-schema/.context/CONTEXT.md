# @meridian/prosemirror-schema — structural contract

This page explains the compatibility seams between the structural schema, the
separately built TipTap editor, and Yjs. Source specs and history are the
authority for the exact current surface.

## Contracts

- `documentNodes` and `documentMarks` export structural data only: content
  expressions, groups, attrs, isolating flags, and mark exclusions. DOM parsing
  and rendering belong to the editor and markup layers.
- `buildDocumentSchema()` builds the server runtime schema. The app builds its
  TipTap schema separately, so parity must be maintained explicitly.
- `PROSEMIRROR_FRAGMENT_NAME` is the one Y.XmlFragment name shared by app,
  server, and Yjs walks. The protocol subpath exports it without schema setup.
- `RESERVED_CLIENT_ID_MAX` reserves `[0, 999]` for server-authored streams.
  `createCollabYDoc()` re-rolls random authoring docs outside that band before
  they persist or sync.
- `CollabSchemaVersion` triples cross package, port, and domain seams. Strict
  `major.minor.patch` strings are the boundary form; packed integers are
  SQL-only and adapters pack or unpack them. A server accepts the same major;
  a client binds only when its major and minor are at least the head's, and
  patch never gates.
- `collabSchemaKeyTag()` partitions persisted client state by major and minor,
  not patch. The WebSocket carrier is the single
  `meridian.collab.{major}.{minor}.{patch}` subprotocol grammar: the client
  offers exactly one token, and header resolution accepts exactly one matching
  token (absent, zero, or multiple matches resolve to the `0.0.0` sentinel).

## Why parity matters

The server never renders TipTap DOM, but it parses, diffs, mirrors, and
serializes the same Yjs documents. A server schema narrower than the editor's
lets y-prosemirror updates decode on one side and fail on the other, so this
package follows the editor's structural surface (figures, MDX blocks, images,
scene breaks).

## Surface rulings

- `align` is `null`, `"center"` or `"right"`. There is no `"left"`: unaligned is
  the default, and a second spelling would be a ghost state the markup codec
  must reject. Markup carries it as a `Layout` wrapper, so an alignable node
  gains no markup until a writer aligns it.
- `image` takes no marks (MDAST has none). `uploadToken` is ephemeral
  Yjs-only upload identity, absent from Markdown/MDX. A link/image/figure `ref`
  is stored state only, never in Markdown, HTML, MDX or the DOM; `href` or
  `src` is the fallback spelling.

## Change pattern

When the structural surface changes, update the app TipTap extension and
markdown adapters with this package. Append the schema-shape history entry;
never rewrite an existing entry. Additive changes use the next minor version
when compatible, while removals, renames, fragment changes, encoding changes,
or meaning-changing attrs require the major-version process and an explicit
migration or reset decision.

Keep provider behavior, figure upload policy, signed URLs, and editing UI in
app or server domains.
