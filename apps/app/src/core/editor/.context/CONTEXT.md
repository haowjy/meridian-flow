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
- Live peer marks are the session projection of durable trail changes. Their
  anchored popover lazy-reads trail detail and the originating thread snapshot.
  The popover is evidence and navigation only; producing-turn receipt Undo/Redo
  is the sole reversal authority for AI changes.
- Peer-mark manuscript color describes the change, not the thread identity:
  added/modified marks use jade and deletions use crimson. Ordinary ranges rest
  as an underline only; a sweep is the sole resting warning tint. Per-thread
  hues belong only to identity chrome such as the hover label and popover dot.
  Localized mark and trail verbs come from `change-mark-labels.ts`; do not
  duplicate English labels in the ProseMirror extension or UI surfaces.
- Live `DocumentSession`s own an ephemeral `SessionMarkerStore` sidecar.
  Change-event replace sets survive editor remounts during the registry's
  retention window but are never persisted or projected into branch rooms.
  Every accepted replace set advances its group revision before changes admitted
  by the current writer are filtered, so an all-self set still clears older
  marks and fences delayed replays. Unresolved anchors expire on their own timer
  even while the editor is idle; store teardown cancels that timer.
  The ProseMirror projection clears a whole mark only for a local writer edit
  through its range or tick; remote sync, selection, and boundary-adjacent typing
  never clear it.
- Deletion marks are caret-sized inline ticks. A boundary anchor resolves into
  the first or last descendant textblock on its affinity side, falling back to
  the opposite adjacent container; never leave the widget between block nodes
  as an anonymous line. Deletions use crimson for their tick and focus ring.
- Collaboration awareness is a browser protocol boundary: theme-owned cursor
  colors must be resolved before publication and serialized as concrete
  six-digit RGB hex. CSS variables and OKLCH strings are valid token sources,
  not valid y-prosemirror awareness colors.
- Live sessions may be created `detached`: their Y.Doc and IndexedDB persistence
  exist before server transport. Ordinary acquisition of an existing detached
  room leaves it detached; post-create reconciliation explicitly attaches
  transport to that same session once. Retention accepts an explicit detached
  room set so restored pending tabs create local sessions without probing a
  server row that does not exist yet. If an older client already left that room
  terminally denied, post-create reconciliation restarts it before attachment.
  Teardown always preserves IndexedDB by
  default because it may contain the only copy of unsynced words; only confirmed
  cleanup paths may request persistence deletion. Retention and unavailable-room
  recovery must not materialize or replace a detached session implicitly.
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

## Draft review — projection-only view extension

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
- Anchor resolution routes through the shared `relative-position-runtime.ts`
  extraction of the y-prosemirror binding (`ySyncPluginKey` state).
  `Y.RelativePosition` decode is separated from
  decoration construction so anchor handling can be unit-tested without a DOM.
- Remote Yjs sync and a new model from `useInlineReviewSync` re-resolve
  RelativePositions; local writer typing maps the existing set through the
  transaction. The extension has no optimistic attribution path — the next
  server model owns writer attribution. Review dispositions never use browser
  mutation origins or collaborative history; Ctrl+Z is not a review restore
  mechanism.
- Editor-side click seam: mousedown on any decoration DOM
  (`[data-review-operations]`) dispatches
  `setInlineReviewActiveOperation` for the first listed operation. This is
  the editor→sidebar direction of bidirectional linking; the sidebar
  reads plugin state via `useEditorState` and reacts (scroll card into
  view + emphasise). Pure deletions use an empty, visible navigation seam with
  focused-operation emphasis; its DOM contains no manuscript text.

Attribution → highlight color (agent = jade, writer = gold), review palette
lives in `packages/design-tokens/src/ink-jade.css` under `--color-review-*`.

The plugin paints **one decoration per `ReviewHunk.spans` entry** rather
than one per hunk, so nested authorship (a writer edit inside an AI
insertion) renders in each owner's own color — gold inside green. Hunks with no
resolvable spans fall back to whole-hunk coloring via `hunkKind`.

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

The dock Changes view's per-card **Apply** and **Discard** are server
disposition commands. They never edit the review Y.Doc from the browser.
The controller owns pending/settling state by draft id, and the normal preview
refetch replaces the projection and decorations after settlement.

## Math extension decision

Meridian keeps the custom `math_display` node. Do not enable
`@tiptap/extension-mathematics` directly: TipTap v3 adds `blockMath` and
`inlineMath`, which are not in the shared markdown-safe schema.
