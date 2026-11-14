# App editor runtime contracts

This page covers contracts that cross the TipTap, Yjs, session, and feature
boundaries. The app schema must remain structurally aligned with
`@meridian/prosemirror-schema`; schema drift can corrupt shared documents.

## Sessions and local copies

`DocumentSessionRegistry` (`document-session-registry-implementation.ts`) owns the account's live
sessions: one per document id, held by retain/release, closed after a grace once no host wants
it and its unsent edits are acknowledged. A lease is only the account's right to hold one
document's session (`{accountId, projectId, documentId}`): nothing orders or fences it, because
the project's list says whether a document is there.

The browser's local copy of a live document is the IndexedDB database
`documentSessionPersistenceKey(accountId, documentId)` (`local-document-copies.ts`). It is
deleted only when it cannot come back to this account: the node's `purge`, the project, Work
or chat deleted for good, the account removed from the project, or sign-out. A `delete` (a
document in Trash) touches nothing: the server's text room admits a document in Trash until its
purge, so text typed offline into a document someone else deleted is saved into it and a
restore brings it back. `clearLocalCopy` closes the session and deletes the copy; it is called
from the project's list (`features/project/context/list-removal-observer.ts`), which also lists
local databases at start and clears the ones whose node the list says is purged (a tab that
crashed half way leaves one).

One Web Lock per copy keeps a tab from deleting a database another has open: a session holds it
shared from creation to teardown, a deletion takes it exclusive and gives up when it is held.
The tab that holds it clears the copy itself when it reads the same `purge`.

Local document peers are scoped to the exact persistence incarnation and schema,
not a path or unqualified document ID. They exchange Yjs updates and ephemeral
presence; replay is a remote transaction and local convergence is not server
acknowledgement. Teardown removes local awareness and drains reads before
destroying persistence. A cross-tab cache deletion also fences peers on IndexedDB
`versionchange`, before a lifecycle wake can replay from the closing connection.
The replay adapter uses y-indexeddb's public stores and
does not create a second content journal.

A document made in this browser has its session in the registry from the start, under its final
id; there is no handover. Its room connects once the server has the `create` (the server closes
a room for a document it does not know yet non-terminally, and the provider retries).

The production registry has one immutable account epoch. Account close refuses new work
synchronously, then drains providers and leases. Removed sessions transfer to the teardown owner
and remain quarantined until their retryable destroy ledger succeeds.

## Mount and collaboration

- `createEditorExtensions()` is the sole collaborative assembly point. TipTap
  and `buildDocumentSchema()` are built separately, so adding a node or
  attribute requires parity in both. Collaboration uses one
  `PROSEMIRROR_FRAGMENT_NAME` fragment and one sync path.
- A block's adjacent `Y.XmlText` children are one run of text: peers typing into
  an empty block at once create several. One rule reads and writes them
  everywhere: diff the run as one string, send each change to the `XmlText`
  that owns the offset (a boundary insert goes left), and empty a text, never
  delete it, so a peer's concurrent insert and its byline survive. A run of
  texts that are all empty (a writer emptied a run beside an image or a break)
  is not a child the editor compares: without that, the next local edit in the
  block rewrites everything after the empty text and duplicates words. The browser
  editor, the server and `packages/agent-edit` all bind through the one patched
  `@tiptap/y-tiptap` (`patches/@tiptap__y-tiptap@3.0.5.patch`; `y-prosemirror`
  is not a dependency); `agent-edit`'s own writers restate the rule in
  `src/yjs-text-runs.ts`. Stock y-tiptap and y-prosemirror fold the run into
  its first text, delete the rest, and fold again on read (a read that writes).
  To drop the patch when upstream stops doing either, remove the grouping
  changes (`updateYFragment`, `updateYText`, `equalYTextPText`,
  `equalYTypePNode`, `computeChildEqualityFactor`, the `createNodeFromYElement`
  read) and keep `refreshProseMirrorDoc`; then reduce `yjs-text-runs.ts` to what
  the writers still need.
- Known limits, left as they are until writers hit them: deleting a run beside
  an inline atom deletes a peer's concurrent typing into it (a text is emptied
  only when the whole block empties), and a concurrent split moves the bylines
  of the text after the split to the splitting client.
- `EditorMountIdentity` distinguishes live and stable draft review rooms
  and includes every construction fact. `editorMountKey()` becomes the React
  key; a reopened session adds its Y.Doc `guid` so a concrete room swap remounts
  TipTap. Review identity includes both `itemKey` and `roomName`.
- `useMountedEditor()` freezes construction options, binds through the session,
  and owns destruction. It applies editability and `editorProps` to the live
  instance. A new construction dependency belongs in the identity type, not an
  effect dependency list.
- Live sessions use the IndexedDB key of the account and the document id. Draft sessions
  use `{ kind: "indexeddb", key: roomKey }` so reopening or reloading the same
  draft recovers unsent text. A terminal `closed` draft session's teardown clears that exact
  cache; a `removed` live one (the server closed its room at the document's purge) keeps it
  until the list's purge clears it; the painter and local Discard never do. `closeDraftRoom` also retires and drops
  the exact cache when the review owner learns closure through authoritative
  metadata before the socket frame. The pool refuses to reopen that closed id.

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

The session is the only writer of local presence. A transport's provider is
patched never to write local state on an Awareness it did not create: no clear
on destroy, none on `pagehide`. `detachTransport` holds one suspension
and the next attach releases it. The session also suspends on `pagehide` and resumes on `pageshow`
only if it holds that suspension, so a page restored from the back/forward cache
republishes its caret. Peers drop a closed tab when the server sees its socket
close: Hocuspocus 4.3.0 relays no explicit null awareness update.

Peer marks, session markers, and review decorations are projections, never
manuscript content. Peer marks are dormant: no server code sends `change_event`,
so the marker store stays empty ([peer-marks](../../../features/editor/surfaces/peer-marks/AGENTS.md)). The session marker store is ephemeral and group revisions
fence delayed replays. Peer-mark popovers open the owning conversation;
Undo/Redo of an AI change remains the producing-turn receipt's authority.

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
  behavior supplies the contract. `editor-history.ts` is the document's history:
  its `DocumentHistory` is owned by the `DocumentSession`, with the `Y.UndoManager`
  the editor's collaboration plugin uses (`yUndoOptions`), and each collaborative
  editor attaches to it while mounted (range capture, the restore dispatch). It
  orders Yjs stack items with editor-originated text Apply commands. The dedicated keymap and toolbar both use it. Apply stops Yjs
  capture at each Apply boundary, so nearby typing stays in separate native
  segments. History traversal is synchronous: Apply entries enqueue owner-held
  commands, while Yjs Undo/Redo never waits on the network or crosses an Apply
  boundary while skipping native no-ops. Undo gives back the range a change
  started from (a drag, a cut, typing over a selection), captured by
  `editor-history.ts` on `beforeTransaction` and carried through the stack items
  that UndoManager generates. It is never read from y-tiptap's copy, which a
  plugin's appended transaction makes wrong; Yjs alone would map the current
  selection, and a moved range has just been removed. Redo and a caret keep
  y-tiptap's mapped selection. Destroying an editor only detaches it: the
  history lasts as long as the session, so a tab's undo survives its editor (the patched
  y-tiptap undo plugin neither destroys a manager it didn't create nor leaves its
  listeners on it). Only edits written through an editor are tracked, so Ctrl+Z reverts
  the writer's own and leaves peer and model edits alone. Reload resets it. The side, Work, tree-only Apply, and title changes never enter it.
- Slash is one spec over the shared suggestion lane. Its predicate is the whole
  trigger envelope; insertion strategy determines target, schema availability,
  and caret placement. A pick in a table cell remains in that cell. Image picks
  hand an anchored target to the image lane.
- Autoformat uses inherited TipTap rules plus explicit local fence and recovery
  behavior. Auto-pair owns only its declarative character table; Markdown
  delimiters remain input rules. Do not duplicate either mechanism.
- Draft inline review is a projection-only extension installed for review
  mounts. It owns decorations and relative-anchor resolution, never browser
  mutation origins or collaborative history. Passage navigation retains a
  session until mounted-editor acceptance, uses block identity plus text, and
  refuses ambiguous fallback. It acquires one exact container registration; hiding, holding, replacing, or
  destroying that editor revokes the target and ends the jump without
  reacquiring another editor.
- Search-passage navigation lands by block hash (from the block's immutable Yjs
  item id) plus the matched term, in three outcomes: the live block still holds
  the term (mark it there), the term occurs exactly once in the document (mark
  that), or `stale`, which shows a notice. Never land on a choice among
  duplicates: a nearby-but-wrong paragraph is worse than saying nothing was
  found. The highlight is never a selection, clears on the writer's next edit or
  caret move (not on remote Yjs transactions), and its notice expires by
  navigation token, not by the rendering component.
- Autoformat supports headings through
  `######`, fences accept `~~~`, bullets accept `+`, and the fence takes the whole
  lowercased GFM info string (highlighting and the diagram catalog key on it).
  Backspace reverts an inherited transform the last keystroke made. Inherited
  rules must carry the schema's attribute names, not only its type names.
- Block alignment is an `align` attr on paragraph (headings included) and table with only
  `null`, `"center"`, and `"right"` (no `"left"` state). `table-operations.ts`
  refuses row/column moves on a table containing spans, and row zero (the GFM
  header) never moves.
- Writer-visible save state: an outage (`offline` or a stalled cache adoption)
  reads "Saved locally (offline)" until the server acknowledges every local
  change, then briefly "Back online"; "Closed" and "Access lost" always win and
  healthy sessions show nothing. Draft sessions use the same local save copy.
- Draft review paints removed base text red and inserted draft text green,
  including writer edits and formatting. Attribution is a byline/membership
  overlay; it never chooses a third paint colour or splits boxes.
- Keep the custom `math_display` node; do not install TipTap mathematics nodes
  that are absent from the shared schema.

## Interaction mechanics and recovery

These mechanics implement the ownership rules in the guide. Keep the policy
centralized: a new surface must use these seams rather than add a competing
keyboard, pointer, drop, or draft-recovery answer.

### Pointer, keyboard, and drop policy

- **One walk answers every point.** `landing/point-landing.ts` walks the
  document over its boxes and returns a landing for any point, including a
  margin and the space below the last block: `inline` (a caret in writer
  text), `seam` (between blocks, where a paragraph fits) or `source` (inside a
  code block's text, and only a real code block's: a component block is an
  object, so a point over it lands at the seam before or after it). Nothing is outside `view.dom`: the ProseMirror node spans
  the whole pane and carries the margin as its own padding, so a press or a
  drop anywhere on the pane reaches the walk. A press and a drop read the same
  landing; they differ in what they do with it.
- **A press** (`landing/press.ts`) is answered only when no text is under it:
  `handleClick` takes a click on the pane or a container's own element, and
  never one on text or an object. At a seam the nearer neighbour's line keeps
  the pointer's column; a table gets a gap cursor; prose beats source and
  objects, so a seam between a fence and a paragraph puts the caret in the
  paragraph. A fence with no prose beside it takes the caret at its facing
  edge. A press never makes a paragraph, with one exception: past the end of the
  document, when the last block can't take a caret and no gap cursor fits (a
  closed diagram), it appends an empty paragraph and puts the caret in it, the
  only way to reach that spot. `pressSelection` stays pure; the write is in
  `pressOnInertTarget`, so one undo removes the line. A document already ending
  on an empty paragraph gets the caret there, and a press in a cell never makes
  one. A press that lands
  where the caret already stands is left to the browser, which knows the line
  the caret is on. A press in a cell stays in that cell.
- **A selection drag** (`landing/selection-drag.ts`) is the one press on text
  the editor takes. The browser's own text drag refuses a press that counts as a
  third click and, on macOS browsers, waits 150ms (from their source; not run
  here), so the editor lifts the selection itself. ProseMirror's `mousedown`
  runs first (it counts clicks), then a listener on `view.dom` prevents the
  default when the press is on the highlight of a nonempty `TextSelection` or
  `AllSelection` (the test ProseMirror's own `dragstart` applies: `posAtCoords`
  at the pointer lies in the selection's range; at either end, its x-coordinate
  must also be on the selected side of the caret, so half of the adjacent glyph
  does not count). The space between lines and the blank past a covered line's
  last word count; unselected text after the range does not. The view must
  also be focused and editable, with no modifier and a chrome kernel.
  `handleDoubleClick` and `handleTripleClick` claim a
  second or third press there so neither the browser nor ProseMirror widens
  the selection; the claim also records a third press for the no-travel case. The file has two halves:
  `trackPress` (`chrome/track-press.ts`; follows a press, mouse or pointer,
  and decides click or lift; it ends a `mousedown` on `mouseup` and a
  `pointerdown` on `pointerup`, treats a `pointermove` with the left bit
  clear as the release, and swallows the `click` after a lift) and
  `liftSelection` pumps the drag events. The block gesture uses the same
  tracker. The tracker's host has two callbacks: `lift` returns the move
  handler, and `end(how, at)` is the one ending (`click`, `drop` or `cancel`;
  the `stop` it returns is `end("cancel")`), so tearing the view down mid-drag
  finishes the lift. A mouse-started press follows any pointer but touch, so a
  pen lifts too. Past the slop (4px, `Math.hypot`, `pastSlop`, shared with the
  chrome sweep and link clicks) it sends a synthetic
  `dragstart` (at `view.dom`, positioned at the press, since a fast first move
  may already be off the selection) with a real `DataTransfer`, then every 50ms `dragleave`/`dragenter`
  on a target change and `dragover` (so the caret, the 5s caret timeout and
  autoscroll behave as in a native drag); release sends one more `dragover` at the
  release point (a fast drag lands where it is let go), then `drop` only if
  that one was cancelled, then `dragend`. It is a pump into the pipeline
  below, not a second drop path: another surface mounting `LandingExtension`
  (the composer, a second pane) reads it as it reads any drag and copies.
  (A pnpm patch to `@tiptap/core` removed the delete its paste-rule plugin made
  of a drag's source after a drop into another editor; the landing decides move
  or copy.) A press that never travels
  places a caret on release, or selects the textblock for a third press;
  `click` after a lift is swallowed (the link surface would follow a link).
  Escape goes through `chrome.beginDrag`; after a lift `pointermove` stops at
  the window so other panes' hover chrome stays down; a peer edit that changes
  what the selection holds cancels (checked again at release). Left native: presses with a modifier (so
  Ctrl/Option-drag still carries text out of the window; Mac Option is
  unrun), read-only views, editors with no kernel (code documents, the
  composer as a source), cell selections, and objects (`ObjectPhysics`).
- **A drop** (`landing/LandingExtension.ts`) picks the door for the drag once:
  `view.dragging ? sliceDoor : doors[kind]`, where the kind comes from its
  types (`landing/drag-payload.ts`: tree rows, files, or text). It asks the walk
  for the landing, and the door returns one plan (`landing/drop-plan.ts`): the
  caret, the hint and the drop all read it. This is the one caret for every
  drag except a block move, which draws and lands its own top-level seam
  (`block-geometry.ts`). A seam that no blank paragraph covers gets its own new
  paragraph, including past the last block. Three doors take a payload: slices
  (`landing/slice-drop.ts`: text and nodes moved or copied inside the editor,
  or text from outside, read again by the host's text parser where it lands),
  project-tree rows (`extensions/reference-drop/reference-drop-door.ts`, handed
  in from `config.ts`) and files (`file-drop/file-drop-door.ts`, also handed in). The files door takes any
  file: a picture goes through the picture lane, and every other file becomes a chip
  (a plain link to a file uploading into `assets/` of the document's own source),
  placed by the same `placeNodes` the row door uses. Files land in the order the drop
  lists them, a run of chips as one edit; the drop point is an `anchorRange` pin, read back
  with `resolveAnchorIn` when the chips go in, because a peer's update (a model streaming)
  replaces the whole fragment and ProseMirror's mapping would land between blocks; a file over `MAX_UPLOAD_BYTES` is refused
  alone, before anything is inserted for it. A chip's progress and failure are the upload
  store's (`core/uploads/upload-store.ts`), as a Composer chip's and a picture slot's are: a
  failed chip (or one taken back by undo and returned by redo) reads failed and a press retries
  it on the same id. Another tab hears a chip's upload over presence (`upload-presence.ts`).
  `landing/` imports neither lane. A host mounts only the doors it has; a
  payload with no door is unclaimed at `dragover`, `drop` and `handleDrop`
  alike, and the click route rides with the plugin, so a code file and the
  Composer have it too. A nonempty slice still goes through the landing when
  the types also list Files. A drag with a plan is claimed at `dragover`, and a
  refusal sets `dropEffect = "none"`: an unclaimed file is opened by the
  browser. `dragover` is a capture listener on `view.dom`, because a node view
  stops it before `handleDOMEvents` and SVG children can stop the bubble.
  `dragleave` with a null `relatedTarget` (Chrome crossing into SVG) still
  checks the point, so the caret is not cleared while the pointer is in the
  editor. A drag whose files the browser hides until the drop (Safari lists
  none, Firefox `application/x-moz-file`) is taken, and the drop looks again.
  The hint beside the pointer is `landing/drag-hint-store.ts`, drawn by
  `DragHint` in the project feature.
- **Snapping.** The walk takes the nearer side of a chip under the pointer.
  Each door then snaps further on its own (`landing/inline-snap.ts`): a tree
  row moves out of a code span, a chip (an atom or a link naming a file), then
  a word; a picture moves out of a code span only; a slice stays where the walk
  put it, so text dropped in inline code stays in the span. A diagram that is
  not open is one object: a drop beside it lands at the seam before or after
  it. A diagram is open when the editor is focused (`editor.isFocused`, the
  answer the walk and the diagram's node view both read), the selection is not
  a `NodeSelection`, and the caret is inside it.
- **What refuses.** Text dropped into a fence becomes plain characters (a hard
  break is a newline); a slice holding a picture or chip is refused (`Can’t put
  that inside code`). A picture over a fence is refused (`Can’t put a picture
  inside code`) and a tree row too (`Can’t mention inside code`), each with no
  caret. Inline code is not a fence: a tree row or picture there snaps to the
  span's edge; a text slice stays in the span. A dragged file over a fence is
  refused (`Can’t put a file inside code`); a file the editor can't place shows
  `A file can’t go there.` while dragging, and a picture that can't stand at the
  caret shows `A picture cannot go there.` A drop never changes
  the rows or columns of any table (nested ones too) or spills out of its cell.
  One that would is refused: `Can’t put that in a
  table cell` when it lands in a cell, `Can’t move part of a table` when a
  move's deletion would cut a table elsewhere. A slice that changes nothing is
  refused with no hint. A picture or chip in an ordinary slice lands in a cell.
  A move onto the selection's own range changes nothing and shows no hint; the
  unselected part of a block the selection reaches into is an ordinary landing.
- **A move keeps its lines.** Taking a text range out of several textblocks
  never joins them (`landing/range-removal.ts`): a block the range reaches into
  keeps its unselected text and type, with adjacent prose whitespace trimmed so
  the remainder does not start or end with the moved line's space. Code keeps
  its whitespace. A block the range covers whole goes, and so do the containers
  that would be left empty. A block its parent can't lose (a list item's first
  paragraph, the last block, or the last paragraph in a table cell) stays,
  emptied; a fully covered table leaves as one block. A move inside one
  textblock, a node move and a `CellSelection` still use `deleteSelection`.
  Several carried lines land at a gap: before the landing textblock at its start,
  after it at its end, or at a split inside it. The slice closes into blocks and
  ProseMirror fits those blocks where the schema requires it. Lists keep their
  container and order. A whole top-level textblock keeps its type; a top-level
  textblock cut by the source selection takes the landing's type, and a cut last
  block joins the landing's tail. This applies to copies because the door reads
  their source selection too. A slice from outside has no source selection and
  keeps its types. A single-line slice and a landing in code are unchanged.
- StarterKit's dropcursor stays disabled; two landings answering one drag is
  the bug this prevents. `landing/drop-caret.ts` draws the one caret.
  Keyboard behavior follows the same reading, so no input device places a
  caret in a body the page is not showing.
- A key the editor owns is consumed on a refusal as well as on success. Undo
  and Tab cannot fall through to the browser: Tab would move DOM focus out of
  the manuscript and discard later keystrokes. Tab uses one ladder: table
  cells, indent in a fence, sink/lift in a list, then `\t` in prose. A leading
  prose tab is written `&#x9;`; the `packages/markup` codec test keeps it safe.
  The way out is Escape, then Tab or Shift-Tab: an Escape that finds nothing to
  close arms the next key, and the kernel's capture listener hands that one Tab
  to the browser before ProseMirror sees it. Any other key, a pointer press or
  focus leaving the editor disarms it; inside a table cell or a selected object,
  the first Escapes step out of that before one arms. The editor's accessible
  description (a hidden element named by `aria-describedby`) says so; there is
  no visible hint.
  Enter in cell prose splits the paragraph; Shift-Enter is the hard break.
- A node view that hides its own text derives that face from the selection and
  never restructures around it. A caret inside a rendered diagram fence shows
  the source face without changing selection, whether it arrived by key,
  command, peer write, or pointer.
- The `@` lane keeps spaces inside a nonempty multiword query, but whitespace
  immediately after the triggering `@` makes that occurrence literal.
  Eligibility reads document text; do not replace this rule with
  `allowSpaces: false` or a Space key handler.

### Live session teardown

- A session holds the writer's undo (`session.history`), so teardown ends it. The registry's
  3 s grace therefore applies to documents no open tab keeps (see `useOpenTabSessions`).
- A retained session's socket is open when some owner wants it (a host is on screen, reported
  through `setHosted` / `retain`'s `detachedDocumentIds`) or it has unsent edits it can still
  deliver. One function, `DocumentSessionRegistry.reconcileRetainedSessions`, applies that on every
  retain/release, and the session's own snapshots re-apply it when the edits are acknowledged.
  Nothing else attaches or detaches a retained live session. `DocumentSession.detachTransport`
  also cancels an attach still waiting for local persistence.
- When the last host releases a live document, the registry retires its session after a
  3 s grace. A session with unacknowledged edits is held instead, so edits made offline
  reach the server without the writer reopening the document. Reopening takes the
  same session back and cancels the hold.
- `DocumentSession.canDeliverUnsentEdits()` says whether the wait can still end in
  delivery. It is false for a reset, unauthorized, terminal, destroyed or read-only room
  (the server drops a read-only room's writes without closing it). The live registry
  and `DraftRoomPool` both ask it; neither keeps its own list.
- A held session ends when the server acknowledges its edits, when the predicate turns
  false, when the room is refused, the document removed or access revoked
  (`dropRefusedRoom`, `drainDocument`, `drainAccess`), when the account closes
  (`invalidateAll`), or after `UNSENT_EDITS_HOLD_MAX_MS` (10 min) spent connected
  without an acknowledgement. That cap is for a room that answers but never accepts; the
  clock runs only while the connection is up and restarts on each drop, so offline time
  never counts and a writer who types on a train gets delivery on reconnect, however
  long it takes. (Elapsed connected time, not a refusal count: the transport counts
  refusals for draft rooms only, and a live-room count would change every live session.)
  The edits stay in IndexedDB in every case.
- A removed room (4208) retires at once, before an availability check can prove a
  restore and restart it; its edits wait in IndexedDB for the next open.
- Restarting a removed or unavailable room cancels its pending teardown and schedules
  it again when no host retains the room.

### Draft room retirement

- `DraftRoomPool` retains stable `draft:<draftId>` rooms without leases. The last
  owner releases through a grace period; a room with unacknowledged edits drains
  before retirement. The drain ends when the server acknowledges the edits or when
  `canDeliverUnsentEdits()` turns false, read-only access included. Ordinary retirement keeps IndexedDB state. There is no
  draft-generation replacement or writer-operation handoff to a new draft.
- Terminal `4205` (`closed`) and `4208` (`removed`) end that identity and clear
  its exact cache. The account command owner also handles authoritative metadata
  `gone` through the same disposition, including when metadata beats the socket
  close. Availability decides live navigation versus removal presentation;
  failed reads never prove closure. See the
  [review runtime](../../../features/draft-review/.context/draft-review.md).
- `resetDisposition` is the session transport's terminal-state vocabulary,
  not a draft reset protocol. Schema fences, authorization loss and explicit
  session rebuild retain their own meanings; local text Discard does not retire
  the room, selection or UndoManager.
- A draft update refusal (`1008`) is bounded: after three consecutive refusals
  without acknowledgement, the transport ends `DRAFT_UPDATES_REFUSED`
  (`updatesRefused`). A retained room stays read-only with its unsent text and
  offers Reopen draft; it does not retry indefinitely. A `4207
  draft-prefix-missing` close is an ordinary reconnect, not a refusal. The next
  handshake's SyncStep2 supplies missing bytes before held keystrokes.
