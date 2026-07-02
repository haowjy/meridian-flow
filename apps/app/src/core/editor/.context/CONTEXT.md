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

## Draft review — DraftInlineReviewExtension

Colocated under `extensions/inline-review/`. The extension is a ProseMirror
plugin that owns a single `DecorationSet` describing every hunk in the current
server review model.

- Only installed when the editor is bound to a draft room. The
  `enableDraftInlineReview` flag on `createEditorExtensions` picks it up when
  `EditorView` receives `reviewDraftId`; live editors never pay for it.
- The plugin is the sole owner of decoration state. React talks to it via TipTap
  commands (`setInlineReviewModel`, `setInlineReviewActiveOperation`,
  `scrollInlineReviewOperationIntoView`) — never by holding decoration objects.
- Anchor resolution routes through the y-prosemirror binding
  (`ySyncPluginKey` state). `Y.RelativePosition` decode is separated from
  decoration construction so anchor handling can be unit-tested without a DOM.
- Local edits map decorations via `DecorationSet.map`. Full re-resolution from
  RelativePositions runs only when a new model arrives from
  `useInlineReviewSync` (debounced refetch of `useDraftPreview`).
- Fallback: when `reviewMode: "panel"` comes back from the server, callers
  route the writer to the docked `DraftDiffPanel` — the plugin is passive here.
- Editor-side click seam: mousedown on any decoration DOM
  (`[data-review-operations]`) dispatches
  `setInlineReviewActiveOperation` for the first listed operation. This is
  the editor→sidebar direction of bidirectional linking; the sidebar
  reads plugin state via `useEditorState` and reacts (scroll card into
  view + emphasise). The event is not swallowed — the writer's caret
  placement inside real editable text is preserved.

Attribution → highlight color (agent = jade, writer = gold), review palette
lives in `packages/design-tokens/src/ink-jade.css` under `--color-review-*`.

## Draft review sidebar (features/editor)

`DraftReviewSidebar` renders one proposal card per operation as a
right-side rail inside `EditorView` during inline review. The rail is
mounted via `EditorView`'s `renderRightRail` render-prop slot (composition
root: `ContextEditorMountHost`) and hides below the `lg` breakpoint so
narrow viewports fall back to the docked diff panel from `DraftReviewBar`.

- Ordering + shape derivation lives in the pure
  `features/editor/inline-review-sidebar-order.ts` helper (unit tested).
- Card→editor: card click dispatches
  `setInlineReviewActiveOperation` + `scrollInlineReviewOperationIntoView`.
- Editor→card: plugin's mousedown seam sets the active operation;
  `useEditorState` re-renders the sidebar and the effect scrolls the
  matching card into view.
- Per-operation Discard is stubbed for the current phase — the button
  hits an `onDiscardOperation` callback and shows a spinner until it
  resolves. The real reject flow (client-side `reconstructInverse` + Yjs
  update under `HUNK_REJECT_ORIGIN`) lands next phase; the sidebar has a
  `TODO(draft-reject-phase)` marker at the callback site.

## Math extension decision

Meridian keeps the custom `math_display` node. Do not enable
`@tiptap/extension-mathematics` directly: TipTap v3 adds `blockMath` and
`inlineMath`, which are not in the shared markdown-safe schema.
