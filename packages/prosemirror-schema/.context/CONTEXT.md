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
  server collab code and app parity tests.
- **One Yjs fragment name.** `PROSEMIRROR_FRAGMENT_NAME` is the shared
  `Y.XmlFragment` name (`"prosemirror"`). Server mirror code imports it from
  this package; app code must stay aligned when it re-exports or displays the
  fragment name.
- **One Yjs clientID policy.** `RESERVED_CLIENT_ID_MAX` reserves clientIDs
  `[0, 999]` for server-authored Yjs writer streams, with
  `AGENT_EDIT_UNDO_CLIENT_ID` occupying slot `999`. Random-authoring docs that
  may persist or sync use `createCollabYDoc()` so they re-roll out of the
  reserved band before writing.
- **TipTap parity is load-bearing.** The app test
  `apps/app/src/core/editor/schema-parity.test.ts` compares the TipTap schema
  from `createEditorExtensions()` against this package by node/mark names and
  structural shape.

## Current document surface

Nodes:

| Node | Notes |
|---|---|
| `doc`, `paragraph`, `blockquote`, `heading`, `text`, `hard_break` | Basic ProseMirror nodes, structural fields only. |
| `code_block` | Adds nullable `language` attr so fenced code survives markdown projection. |
| `image` | Inline image with `src`, `alt`, and `title` attrs. `src` defaults to an empty string. |
| `bullet_list`, `ordered_list`, `list_item` | List structure with `tight`/`order` attrs for markdown round-tripping. |
| `horizontal_rule` | Scene break / thematic break node for markdown `---` round-tripping. |
| `jsx_leaf`, `jsx_container` | MDX component blocks with `name` and `props` attrs; leaf components contain `text*`, containers contain `block+`. |
| `figure` | Atomic block with `src`, `alt`, `label`, and `caption` attrs for figure workflows. |

Marks:

| Mark | Notes |
|---|---|
| `strong`, `em` | Basic ProseMirror marks, structural fields only. |
| `code` | Excludes all other marks to match TipTap's code mark behavior. |
| `link` | `href` defaults to an empty string; `title` defaults to `null`; non-inclusive. |

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
- Update the app editor extensions and `schema-parity.test.ts` with any schema
  shape change.
- Keep provider/product behavior out of this package. Figure uploads, signed
  URLs, MDX component rendering, and rich editing UI belong in app/editor or server domains.
