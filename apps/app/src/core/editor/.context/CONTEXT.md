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

## Draft review — view extension and reject runtime

Colocated under `extensions/inline-review/`. The extension is a ProseMirror
plugin that owns a single `DecorationSet` describing every hunk in the current
server review model. Keep this directory view-only: plugin state, decorations,
commands, and the lightweight hunk model used by the plugin.

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

The plugin paints **one decoration per `ReviewHunk.spans` entry** rather
than one per hunk, so nested authorship (a writer edit inside an AI
insertion) renders in each owner's own color — gold inside green, matching
the mock. Hunks with no resolvable spans fall back to whole-hunk coloring
via `hunkKind`. Alongside model decorations, the plugin owns an
**optimistic writer overlay**: local user transactions (`!ySyncPluginKey.isChangeOrigin`
+ not `addToHistory: false`) add gold spans to `optimisticDecorations`
covering the just-typed ranges. `set-model` clears the overlay — the
refreshed server model is authoritative and its own writer spans take
over. `props.decorations` merges the overlay onto the model set.

Operation rejection runtime lives next to the editor core in
`core/editor/inline-review-runtime.ts`, not in the extension barrel. It decodes
draft journals, reconstructs inverse Yjs updates, and applies the tracked reject
origin. That code depends on persisted journal semantics and Yjs undo-manager
runtime behavior, so keeping it outside `extensions/inline-review/` preserves the
extension boundary: view model in the extension, reconstruction side effect in
the runtime module.

## Change-trail navigation

`change-trail-navigation.ts` is the authorize/open/sync/validate boundary for
historical trail clicks. It temporarily retains the target `DocumentSession`
until the synced Y.Doc anchor has passed `@meridian/agent-edit`'s item-ID block
validation and the mounted live editor accepts the range. The always-installed
`LiveRangeNavigationExtension` owns the temporary decoration and scrolling;
zero-width deletion anchors render a caret-like boundary rather than inventing
a replacement range. Chat supplies route resolution, but must not decode,
validate, or map anchors itself.

## Per-operation discard (dock Changes cards)

The dock Changes view's per-card **Discard** rejects one operation without
re-editing the draft. The command fetches the immutable draft journal for the
model's `draftRevisionToken` (cached per revision), decodes base64 bytes into a
`JournalSnapshot`, reconstructs the inverse for that operation's server-provided
`rejectSourceUpdateIds`, calls `undoManager.stopCapturing()`, then applies the
inverse to the draft Y.Doc with `HUNK_REJECT_ORIGIN`. The inverse syncs through
Hocuspocus as a normal draft update row; decorations disappear on the normal
debounced preview refetch. A stale state-vector refetches preview and retries.
The controller state machine owns pending/settling state by draft id; the card
only names the operation.

Collaboration passes `yUndoOptions.trackedOrigins = [HUNK_REJECT_ORIGIN]`
uniformly for live and draft editors. TipTap/y-tiptap still adds its own
`ySyncPluginKey` origin for typing; live editors never emit the reject origin,
so the config is inert outside draft review, but Ctrl+Z can restore a discarded
operation while it is under review.

## Math extension decision

Meridian keeps the custom `math_display` node. Do not enable
`@tiptap/extension-mathematics` directly: TipTap v3 adds `blockMath` and
`inlineMath`, which are not in the shared markdown-safe schema.
