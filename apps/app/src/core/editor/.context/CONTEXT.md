# App editor — TipTap/Yjs runtime contract

The app editor builds the browser-side TipTap schema and binds it to the shared
Yjs document session. It must stay structurally aligned with
`@meridian/prosemirror-schema`; schema drift corrupts y-prosemirror documents.

## Contracts

- `createEditorExtensions()` is the only app-side extension assembly point for
  collaborative documents. `schema-parity.test.ts` compares its TipTap schema
  against `buildDocumentSchema()`.
- Collaboration uses the shared `PROSEMIRROR_FRAGMENT_NAME` Y.XmlFragment. Do
  not create a second fragment name or a second editor sync path.
- `DocumentSessionRegistry` is keyed by the Yjs room key, not by editor surface:
  live rooms use the bare document id, draft-review rooms use
  `draft:<draftId>` from `@meridian/contracts/protocol`. Switching live ↔ draft
  is a session identity change and must remount the TipTap editor because
  Collaboration binds to a concrete Y.Doc/fragment at construction.
- Live sessions may use versioned IndexedDB persistence. Draft review sessions
  do not: the draft Hocuspocus room is server-persisted and short-lived, and a
  local draft cache risks stale recovery across review sessions.
- TipTap extensions may provide editing behavior, but they must not add node or
  mark types outside the shared schema unless the schema package and server
  markdown adapter are updated in the same change.

## TipTap v3 defaults we intentionally disable

- `trailingNode: false` — TipTap v3's StarterKit can append a trailing paragraph
  after terminal blocks. In this Yjs-backed editor that would be a real shared
  document mutation on open/sync, not visual chrome. Keep trailing-space UX as an
  explicit editor feature if needed, not an inherited StarterKit default.
- `undoRedo: false` — collaborative history is not TipTap local history.
- `link`, `underline`, `listKeymap` and built-in camelCase schema extensions are
  disabled where Meridian installs custom schema-parity wrappers.

## Math extension decision

Meridian keeps the custom `math_display` node. Do not enable
`@tiptap/extension-mathematics` directly: TipTap v3 adds `blockMath` and
`inlineMath`, which are not in the shared markdown-safe schema.
