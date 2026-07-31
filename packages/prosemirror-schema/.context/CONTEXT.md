# @meridian/prosemirror-schema — Structural Schema Contract

This package is the shared ProseMirror document shape. It exists so the
frontend TipTap/y-prosemirror editor and server Yjs mirror build compatible
documents from the same node/mark specs.

## Contracts

- **Structural specs only.** `documentNodes` and `documentMarks` export
  ProseMirror structural data: content expressions, groups, attrs, isolating
  flags, mark exclusions, and similar schema rules. They deliberately strip
  `parseDOM` and `toDOM`; DOM behavior is owned by the editor layer.
- **One runtime builder.** `buildDocumentSchema()` constructs the schema used by
  server collab code. The app constructs its TipTap schema separately; parity is
  currently unenforced.
- **One Yjs fragment name.** `PROSEMIRROR_FRAGMENT_NAME` is the shared
  `Y.XmlFragment` name (`"prosemirror"`). Server mirror code imports it from
  this package; app code must stay aligned when it re-exports or displays the
  fragment name.
- **One Yjs clientID policy.** `RESERVED_CLIENT_ID_MAX` reserves clientIDs
  `[0, 999]` for server-authored Yjs writer streams, with
  `AGENT_EDIT_UNDO_CLIENT_ID` occupying slot `999`. Random-authoring docs that
  may persist or sync use `createCollabYDoc()` so they re-roll out of the
  reserved band before writing.
- **One schema-version algebra.** `CollabSchemaVersion` triples are the only
  representation that crosses package, port, or domain seams. Strict
  `major.minor.patch` strings are boundary serialization; packed integers
  (`major * 1_000_000 + minor * 1_000 + patch`) are SQL-only and must be
  packed/unpacked inside Drizzle adapters. A server serves any head with the
  same major. A client may bind only when its `(major, minor)` is at least the
  head's; patch never gates. Minor is additive even in `0.x`.
- **One client-state partition tag.** `collabSchemaKeyTag()` returns
  `v{major}.{minor}`. IndexedDB persistence, reload guards, and fence quarantine
  reuse state across patch releases but not across schema-surface changes.
- **One WebSocket carrier grammar.** The client offers
  `meridian.collab.{major}.{minor}.{patch}` as its sole Yjs subprotocol.
  Header resolution accepts exactly one matching offered token; absent, zero,
  or multiple matches resolve to the `0.0.0` sentinel. Echo selection returns
  that sole match, otherwise the first offered token, or nothing when no token
  was offered.
- **TipTap parity is load-bearing.** The app test
  `apps/app/src/core/editor/schema-parity.test.ts` mechanically compares the
  TipTap schema from `createEditorExtensions()` against this package by
  node/mark names and structural specs.

## Current document surface

Nodes:

| Node | Notes |
|---|---|
| `doc`, `blockquote`, `text`, `hard_break` | Basic ProseMirror nodes, structural fields only. |
| `paragraph`, `heading` | Basic nodes plus the `align` attr. |
| `table`, `table_row`, `table_header`, `table_cell` | GFM table structure. `table` carries `align`; cells carry `alignment`, `colspan`, `rowspan`, and `colwidth` for prosemirror-tables editing. |
| `code_block` | Adds nullable `language` attr so fenced code survives markdown projection. |
| `image` | Inline image with `src`, `alt`, `title`, `uploadToken`, and `width` attrs. `src` defaults to an empty string. `uploadToken` (nullable, 0.3.0) is the ephemeral upload identity; `width` (nullable, 0.4.0) is the writer-chosen display width in CSS pixels. |
| `bullet_list`, `ordered_list`, `list_item` | List structure with `tight`/`order` attrs for markdown round-tripping. |
| `horizontal_rule` | Scene break / thematic break node for markdown `---` round-tripping. |
| `jsx_leaf`, `jsx_container` | MDX component blocks with `name` and `props` attrs; leaf components contain `text*`, containers contain `block+`. |
| `figure` | Atomic block with `src`, `alt`, `label`, `caption`, and `uploadToken` attrs for figure workflows. `uploadToken` (nullable, 0.3.0) is the ephemeral upload identity shared with `image`. |

`align` is `null`, `"center"`, or `"right"` and validates on the way in. There
is no `"left"`: unaligned is the default, and a second spelling for it would be
a ghost state the markup codec has to reject. `@meridian/markup` carries these
attrs over the wire as a `Layout` wrapper, so an alignable node gains no markup
until a writer aligns it.

Marks:

| Mark | Notes |
|---|---|
| `strong`, `em` | Basic ProseMirror marks, structural fields only. |
| `code` | Excludes all other marks to match TipTap's code mark behavior. |
| `link` | `href` defaults to an empty string; `title` defaults to `null`; non-inclusive. |
| `strike` | Structural strikethrough mark. |

## Rationale

The server never renders TipTap DOM, but it does parse, diff, mirror, and
serialize ProseMirror/Yjs documents. If the server schema is narrower than the
editor schema, y-prosemirror updates can decode on one side and fail on the
other. The shared package therefore follows the app editor's structural surface,
including richer document nodes such as figures, MDX components, images, and
markdown scene breaks, while leaving product UX and DOM rendering out of scope.

## Patterns

- Add a node/mark here only when the app TipTap schema and server collab logic
  both need to accept that structure.
- Update the app editor extensions with any schema shape change; the parity
  guard enforces the mirrored structural contract.
- Keep provider/product behavior out of this package. Figure uploads, signed
  URLs, MDX component rendering, and rich editing UI belong in app/editor or server domains.
