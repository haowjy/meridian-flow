# App editor runtime contracts

This page covers contracts that cross the TipTap, Yjs, session, and feature
boundaries. The app schema must remain structurally aligned with
`@meridian/prosemirror-schema`; schema drift can corrupt shared documents.

## Session authority

`document-session-cross-context-coordination.ts` owns admission, local session
and lease maps, and account-close ordering. Recovery, locks, and wakeup request
work through that owner; they must not create a second session map or authority
store. `AccountResourceReplica` owns browser-local resource reservations and
exact persistence. The editor session adopts acknowledged resource sessions
without replacing their Y.Doc or IndexedDB database.

Local document peers are scoped to the exact persistence incarnation and schema,
not a path or unqualified document ID. They exchange Yjs updates and ephemeral
presence; replay is a remote transaction and local convergence is not server
acknowledgement. Teardown removes local awareness and drains reads before
destroying persistence. The replay adapter uses y-indexeddb's public stores and
does not create a second content journal.

### Adoption protocol

`ResourceSessionAdoptionCoordinator` is the only driver of local-to-registry
adoption. The durable state is the pair (resource obligation, room
`persistence`): Owed (obligation only), Reserved (room `adopting-local`, which
carries no generation), Committed (room `bindable{G}`), Settled (obligation
dropped and `lifecycle.availabilityGeneration = G`), with `terminal-local` off to
the side. No generation is stored before the one fenced commit that admits it.
That commit is `Coordination.admit(..., { adoption })`: one operation-lock
section in which `store.admit` decides the fences and writes
`adopting-local -> bindable`, then the lease installs and content ownership
converts. Its `prepareCommit`/`completeCommit` hooks return `undefined`, so an
`async` hook does not typecheck (a `void` return would accept one); Web Locks
are not reentrant. Every pass re-derives its step from durable state with a
fresh admission, so reload, a busy lock, a fence refusal or a failed
acknowledgement all resume the same way. `ResourceContentAccess.abortTransfer`
settles both reservation owners (the content entry and the registry facet) and
is a no-op after the commit.

The acknowledged generation is the room's incarnation, never a lease's
admission, which can be fresher. The local commit reads it from the store's
decision. Server-session capture reads it from the registry's private
`LiveSessionIncarnationPort` (`incarnationOf(session)`), keeps the fresh
admission only for the fence check, and records both the lifecycle and the
retained ownership at the incarnation.

The production registry has one immutable account epoch. Account close fences
admission synchronously, then drains providers, leases, adopted sessions, and
registered feature resources. Removed sessions transfer to the teardown owner
and remain quarantined until their retryable destroy ledger succeeds. A pending
open may initiate close after an authority failure but must not await the same
barrier that drains that open.

## Mount and collaboration

- `createEditorExtensions()` is the sole collaborative assembly point. TipTap
  and `buildDocumentSchema()` are built separately, so adding a node or
  attribute requires parity in both. Collaboration uses one
  `PROSEMIRROR_FRAGMENT_NAME` fragment and one sync path.
- `EditorMountIdentity` distinguishes live and draft (`branch:<draftId>`) rooms
  and includes every construction fact. `editorMountKey()` becomes the React
  key; a reopened session adds its Y.Doc `guid` so a concrete room swap remounts
  TipTap. Draft identity includes both `itemKey` and `roomName`.
- `useMountedEditor()` freezes construction options, binds through the session,
  and owns destruction. It applies editability and `editorProps` to the live
  instance. A new construction dependency belongs in the identity type, not an
  effect dependency list.
- Live sessions may use a qualified, generation-aware IndexedDB key. Draft
  sessions use no local cache because a cache can recover into a draft that was
  closed and reopened. Unacknowledged draft edits are drained on release;
  nothing is carried to a successor room.

`DocumentSession` status combines persistence and transport: `detached`,
`syncing`, `synced`, `offline`, `access-lost`, or `destroyed`; `schemaFence` is
orthogonal. `synced` means the transport handshake completed, not that all
local edits are saved. `serverHasLocalChanges` is true only after that
handshake and every update on the current connection is acknowledged. Outbox
and acknowledgement are edge observations, not per-keystroke snapshots; the
transport stores bytes before sending them (see
[`../../transport/.context/CONTEXT.md`](../../transport/.context/CONTEXT.md)).

Before binding, `EditorView` waits for local persistence. Verified detached
content may bind without first server sync; other sessions use the existing
overall timeout, whose expiry permits degraded evidence but not upload
authorization.

## Schema repair and presence

`DocumentSession.bindEditor()` owns one schema-repair witness per Y.Doc and one
update listener across open and live phases. It captures the pre-bind snapshot
immediately before construction, receives attribution from each bound view,
and removes only that view's callbacks on release. Later views consume the
session verdicts. Delete-only candidates are correlated independently within a
Yjs transaction batch by item identity; ordinary writer transactions produce no
verdict. Mixed delete-and-insert normalization is intentionally not classified.
Repairs are reported in the snapshot; they do not fence, quarantine, pause, or
change connection status.

Local presence is owned by `local-presence.ts`. Extensions receive `setField`,
read-only peer state, and an Awareness-shaped caret facade; they never receive
the mutable Awareness instance. Suspension publishes null while retaining the
desired map, nested suspension republished only at the outer boundary. Draft
review rotates the document client while migrating suspended fields. A second
presence write path or cached client ID creates ghost carets.

Live peer marks, session markers, and review decorations are projections, never
manuscript content. The session marker store is ephemeral and group revisions
fence delayed replays. Peer-mark popovers navigate to durable trail receipts;
The writer removes an AI change by discarding it in the draft or with Ctrl+Z.

## Anchors and holds

Remote Yjs sync rebuilds the whole ProseMirror document. Numeric positions map to
seams and can report deleted even when the target still exists. Long-lived UI
uses `EditorAnchor` backed by Y.RelativePositions, resolves it at use time, and
validates the object found there. `NodeHold` adds the Yjs element identity and
node type, so a deleted node releases rather than retargeting a replacement.
`carryAnchor` is used where plugin `apply` runs before the binding settles; read
resolution happens later. Every resolution is bounds-checked.

DOM elements are geometry only. Node views and decoration spans can be rebuilt
without content moving, so a surface drops elements after measuring and holds
identity in anchors or holds.

## Editor policy seams

- Disable TipTap's trailing node and local undo defaults where collaborative
  behavior supplies the contract. The Yjs UndoManager and the dedicated keymap
  own undo, including recovery from AI writes.
- Undo is per surface, not per room. `UndoOwnershipExtension` gives each surface
  (the Editor, the dock) its own transaction origin, stamped on its binding's
  writes and its Discards, and its UndoManager keeps only those, so Ctrl+Z in one
  view never undoes the other's typing. The history belongs to
  `DocumentSession.historyFor(surface)`, so a presenter handoff keeps it. The
  stamp comes from an exact-version `pnpm patch` of `@tiptap/y-tiptap`; bumping
  it fails the install until the patch is re-ported. After patching, run
  `pnpm dev:restart`.
- Slash is one spec over the shared suggestion lane. Its predicate is the whole
  trigger envelope; insertion strategy determines target, schema availability,
  and caret placement. A pick in a table cell remains in that cell. Image picks
  hand an anchored target to the image lane.
- Autoformat uses inherited TipTap rules plus explicit local fence and recovery
  behavior. Auto-pair owns only its declarative character table; Markdown
  delimiters remain input rules. Do not duplicate either mechanism.
- Draft inline review is a view-only extension installed for draft mounts. It
  paints a review the browser computed from the draft text against `review_base`
  and stores no anchors of its own. Discard is a local edit under the editor's own
  undo origin, so Ctrl+Z restores it. Change-trail navigation retains a
  session until item-ID validation and mounted-editor acceptance. Passage
  navigation uses block identity plus text, and refuses ambiguous fallback.
- Search-passage navigation lands by block hash (from the block's immutable Yjs
  item id) plus the matched term, in three outcomes: the live block still holds
  the term (mark it there), the term occurs exactly once in the document (mark
  that), or `stale`, which shows a notice. Never land on a choice among
  duplicates: a nearby-but-wrong paragraph is worse than saying nothing was
  found. The highlight is never a selection, clears on the writer's next edit or
  caret move (not on remote Yjs transactions), and its notice expires by
  navigation token, not by the rendering component.
- Autoformat is wider than the original ruling on purpose: headings reach
  `######`, fences accept `~~~`, bullets accept `+`, and the fence takes the whole
  lowercased GFM info string (highlighting and the diagram catalog key on it).
  Backspace reverts an inherited transform the last keystroke made. Inherited
  rules must carry the schema's attribute names, not only its type names.
- Block alignment is an `align` attr on paragraph, heading, and table with only
  `null`, `"center"`, and `"right"` (no `"left"` state). `table-operations.ts`
  refuses row/column moves on a table containing spans, and row zero (the GFM
  header) never moves.
- Writer-visible save state: an outage (`offline` or a stalled cache adoption)
  reads "Saved locally (offline)" until the server acknowledges every local
  change, then briefly "Back online"; "Closed" and "Access lost" always win and
  healthy sessions show nothing. Unacknowledged branch edits are lost if the tab
  closes or the writer signs out before acknowledgement.
- Draft review paints red (removed) and green (added) only. Authorship is not painted.
- Keep the custom `math_display` node; do not install TipTap mathematics nodes
  that are absent from the shared schema.

## Interaction mechanics and recovery

These mechanics implement the ownership rules in the guide. Keep the policy
centralized: a new surface must use these seams rather than add a competing
keyboard, pointer, drop, or branch-recovery answer.

### Pointer, keyboard, and drop policy

- A press outside the prose is answered once by `pointer-boundary.ts`, not by
  the layout component that caught it. Gutters, the page below the last block,
  and the strip between blocks place a caret. An outside press never lands in
  an opaque object's interior; at a seam prose beats source. Keyboard behavior
  follows the same reading, so no input device places a caret in a body the
  page is not showing.
- A key the editor owns is consumed on a refusal as well as on success. Undo
  and Tab cannot fall through to the browser: Tab would move DOM focus out of
  the manuscript and discard later keystrokes. Tab uses one ladder: table
  cells, indent in a fence, sink/lift in a list, then `\t` in prose. A leading
  prose tab is written `&#x9;`; the `packages/markup` codec test keeps it safe.
  Enter in cell prose splits the paragraph; Shift-Enter is the hard break.
- A drop inside a table lands inside a cell, never between two. `table-drop.ts`
  is the one landing for the dropcursor, node drag, and OS-file drop. StarterKit's
  dropcursor stays disabled; two landings answering one drag is the bug this
  seam prevents.
- A node view that hides its own text derives that face from the selection and
  never restructures around it. A caret inside a rendered diagram fence shows
  the source face without changing selection, whether it arrived by key,
  command, peer write, or pointer.
- The `@` lane keeps spaces inside a nonempty multiword query, but whitespace
  immediately after the triggering `@` makes that occurrence literal.
  Eligibility reads document text; do not replace this rule with
  `allowSpaces: false` or a Space key handler.

### Branch retirement

- Branch retirement never replays the retired AI snapshot, and nothing is
  carried to a successor room. The transport owns the outbox; `BranchRoomPool`
  holds one room per draft id and drains it on release.
- `resetDisposition` gives the reset its meaning: `superseded` and `rebuild`
  keep unacknowledged updates for retirement (the draft closed), `refused` rejects
  pending edits, and `schema` fences the room.
