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
- Block ids: `extensions/block-id` edits each local transaction in flight (`filterTransaction`,
  not `appendTransaction`, which would reset the input rule it follows and with it Backspace's
  undo of the rule). The block the old document had at that place keeps its id; a split's other
  half, a pasted copy and any block with none get a fresh one; a cut block's id is free, so a
  paste or drop keeps it. The id rides the clipboard as `data-block-id`. Transactions from the
  Yjs binding (a peer's change, undo, redo, the first load) are left alone: their blocks
  already have ids. Undo never takes an id away: the document's `UndoManager`
  (`editor-history.ts`) refuses to delete an `id` attribute, because a paragraph survives its
  creator's undo and would keep a peer's text with no id. A pure keystroke is repaired only in
  the block typed in; a stored block with no id (written before ids were assigned on every path)
  gets its id when someone types in it or edits its structure, and a Draft cannot be seeded from
  the document until then. There is no migration; nothing deployed holds one.
- A block's adjacent `Y.XmlText` children are one run of text: peers typing into
  an empty block at once create several. One rule reads and writes them
  everywhere: diff the run as one string, send each change to the `XmlText`
  that owns the offset (a boundary insert goes left), and empty a text, never
  delete it, so a peer's concurrent insert and its byline survive. A run of
  texts that are all empty (a writer emptied a run beside an image or a break)
  is not a child the editor compares: without that, the next local edit in the
  block rewrites everything after the empty text and duplicates words. The browser
  editor, the server and `packages/agent-edit` all bind through the one patched
  `@tiptap/y-tiptap` (`patches/@tiptap__y-tiptap@3.3.0.patch`; `y-prosemirror`
  is not a dependency); `agent-edit`'s `applyOps` (`model/y-prosemirror.ts`) restates the
  rule by addressing units across a block's texts. Stock y-tiptap and y-prosemirror fold the run into
  its first text, delete the rest, and fold again on read (a read that writes).
  To drop the patch when upstream stops doing either, remove the grouping
  changes (`updateYFragment`, `updateYText`, `equalYTextPText`,
  `equalYTypePNode`, `computeChildEqualityFactor`, the `createNodeFromYElement`
  read) and keep `refreshProseMirrorDoc`, `sameBlock` and the forced-render selection
  resolver (until upstream resolves valid selections there too).
- `updateYText` places a typed or deleted run where the transaction put it (`placeByStep`). `simpleDiff`
  puts an edit at the far end of any run of equal characters, so a space typed before a space, or
  a letter beside the same letter, became the item at the other end of the run: the word's
  characters then sat in the wrong item order, and the text of the unsent typing read them
  split and out of order (`Second\nunsent `). The sync plugin's `apply` records the range of a
  local transaction with one changed step inside a text-only block (`binding.edit`, with the block
  node); `updateYText` uses it only for that node and only when it reproduces the new text, after trimming the
  characters the replacement shares at both ends so only the changed ones get new or deleted items. A split,
  a join or a multi-step transaction records nothing and the plain diff stands. To drop it,
  upstream's diff must take the steps' range.
- The binding’s forced render replaces the editor’s document before restoring its selection.
  It resolves offsets from the previous document to a valid selection in the rendered one,
  a text selection when text is available. A clamped offset alone can land at a table
  boundary, where a text selection is invalid.
- Cell selections cross peer updates as cell-boundary positions, cell IDs and
  whole-row/whole-column coverage, not the ending cell's text range. The binding's
  `resolveRelativeCellSelection` first uses live Yjs references, then a unique cell
  ID if a move or Undo recreated the element. It shares that resolution with local
  history. A deleted endpoint never becomes a selected neighboring cell: peer
  updates collapse to a legal caret in the surviving endpoint, or near the mapped
  head if neither survives. This deliberately differs from stock column-delete
  mapping, which can select neighboring cells. Undo's explicit range restore leaves
  the binding's mapped result alone if its cell endpoints cannot be recovered.
  As in stock `CellSelection.map`, a full-row selection expands across added
  columns; otherwise a full-column selection expands across added rows. When both
  apply (all cells selected), the row rule wins, not both rules. The
  corners define the rectangle: inserted interior rows join it; a moved corner can
  reshape it. A whole table can lose whole-table status on an exterior row addition,
  as stock does; this is not a new whole-table selection model. Cells without IDs
  can follow live references but not recreated elements. Duplicate-ID fallback is
  unresolved rather than choosing a copy. Keep both runtime bundles and selection
  declarations aligned when updating the y-tiptap patch.
- A block keeps its Yjs element: `updateYFragment` pairs the children it can't
  match from either end by block `id` (`pairByBlockId`), deletes an old element
  with no partner, inserts a node with none, and never writes a node into an
  element with a different `id` (`sameBlock`). When the pairing must choose
  (blocks swapped), a block this editor's own transaction moved
  (`binding.movedIds`, recorded in the sync plugin's `apply`: its original
  occurrence was deleted and did not come back in place) always loses to one left
  in place, however many moved, so a dragged run is what is re-created and the
  blocks it passed keep their elements and a peer's concurrent typing. A block
  only retyped, or replaced in place by a copy with its id, stays in place, and
  nothing inside a block replaced in place counts as moved. So a command that
  moves blocks writes the move as a delete and an insert of the moved nodes
  (`moveTableRow` and `moveTableColumn` in `table-operations.ts`), never as a rebuilt parent: a
  rebuilt table tells the binding nothing about which row or cell moved, and a tie can
  re-create one a collaborator is typing in. The rule holds only under a
  parent that stays the same block (its id before the write is the node's id) or
  the document. Cells and headers carry ids too, so their paragraphs and nested containers
  pair by id. Children inside a container rewritten in place as another block still pair
  by position. Stock y-tiptap pairs by position and
  child equality (3.3.0 adds a first pass that pairs by the node a Yjs type was last mapped to,
  `reconcileMappedChildren`; the patch bypasses it and keeps the id pairing): Enter at the end of a paragraph followed by an empty one moved
  the empty one's element to the new paragraph. Yjs has no move, so typing a
  peer puts into a block while it is dragged is lost, and two peers dragging one
  block at once leave two copies with one `id`. The fold fuzz
  (`qa/fold-fuzz.md`) checks this rule and the text rule above; run it by hand
  when the patch changes.
- Redoing the y-tiptap patch on a new version: `pnpm patch @tiptap/y-tiptap@<version>`, edit
  `dist/index.js` and `dist/index.cjs` identically (`package.json` `exports` point only at `dist`;
  the shipped `src/` is not patched), then the two `.d.ts`/`.d.cts` declarations, then
  `pnpm patch-commit`. Every change carries a `Meridian patch` comment. The changes are the
  text-run grouping, the id pairing with `movedIds`, the typed-run placement (`binding.edit`), the empty-fragment guard, the forced-render
  selection, `refreshProseMirrorDoc`, the Undo plugin's listener cleanup, the cell-selection
  capture and restore (`resolveRelativeCellSelection`), the gap-cursor restore (a remote edit
  used to turn the gap below a final table into a caret in its last cell), and `recoverSelectionEndpoint` trusting a
  position Yjs resolved into the block with the same `id` (`qa/concurrent-typing.md`; upstream
  [tiptap#8594](https://github.com/ueberdosis/tiptap/issues/8594), open: drop this change once a release fixes it).
- Undo step boundaries: y-tiptap 3.x closes the capture window only for a document-changing
  transaction with `addToHistory: false`; a meta-only one does not. A site that needs its edit to
  be a separate step calls `endUndoStep(state)` (`editor-history.ts`) before the edit: image
  upload, link actions, `@` references, reference drops, a Discard, a block drop. Meta-only
  messages (block hold and lift, review projection, upload progress, reading position) are not
  boundaries.
- Debugging the patched y-tiptap: the `.map` files and `src/` in the package are pristine 3.3.0, so
  devtools shows code that does not run. Set breakpoints in `dist/index.js` itself (delete its
  `//# sourceMappingURL` line locally to stop devtools following the map) and read the patched
  logic from `patches/@tiptap__y-tiptap@3.3.0.patch`. `refreshProseMirrorDoc` there is the headless
  copy of the mapping refresh in `ProsemirrorBinding._typeChanged`; change both together.
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
  draft recovers unsent text. A draft is deleted only with its Work or document, so
  the copy goes with its document at the list's purge (`local-document-copies.ts`). `closeDraftRoom`
  ends the room when the review owner learns the draft is gone through authoritative metadata
  before the socket frame, and the pool refuses to reopen that closed id. A room an owner still
  retains keeps its session, read-only, and its transport ends as the socket's close would end it
  (`endClosed`), so a draft that ended on screen stays readable and sends nothing more. Only an
  unretained closed room retires.
  The tree list's dropped stamp ends the room of a document's create the server dropped (its
  draft was never made, so the room would only retry `DOCUMENT_UNKNOWN`) through
  `closeDraftRoom` (`watchBounces`): its typing is dropped with the pill like any closed draft's.
  Such a draft never answers active, so it never reopens.
- Typing a closed draft's room never sent is dropped with one "Couldn't save" pill (see "Unsent
  typing dropped").

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
change connection status. The witness counts each report with `countSchemaRepair("editor")`
(`@meridian/agent-edit`); the removed-text extraction it reports lives in
`rescued-text.ts`. The binding's delete reaches the server as an ordinary Yjs update,
and the server journals it under no name (`isSchemaRepairUpdate`); Undo still reaches it, which
re-inserts the element and has the binding delete it again.

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
manuscript content. The session marker store is ephemeral and group revisions
fence delayed replays. Undo/Redo of an AI change remains the producing-turn
receipt's authority.

The peer-marks lane (`PeerMarkerExtension`, the marker store, the agent-name
store) is dormant: no server code has sent `change_event` since `92967a8b80`, so
the store stays empty and no mark renders. It is kept for the history feature,
which will decide what marks show. Don't extend it and don't delete it
([peer-marks](../../../features/editor/surfaces/peer-marks/AGENTS.md)).

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
  boundary while skipping native no-ops. An Apply's undo resolves whether it
  happened; when it didn't (a refused or failed Un-Apply), the entry goes back to
  the undo side at its place, unless it was redone or cleared since. An owner can
  also hide an Apply entry (out of both sides) and show it again, back on the undo
  side at its place with the redo side left alone. A guarded step (`DocumentHistory.guard`, a Discard's)
  runs alone: no-op skipping stops before it, and when it is next it runs only if no edit since
  touched its text (`touchedSince`, against the state vector `markStepDone` stored on the step
  when it was done; the notice's Undo reads the same one);
  otherwise it is dropped unrun, which spends the press. The guard follows the step through Undo
  and Redo: a redone step is marked and guarded again from the state the Redo left, so every Ctrl+Z of it
  is checked. Undo gives back the text or cell range a change
  started from (a drag, a cut, typing over a selection), captured by
  `editor-history.ts` on `beforeTransaction` and carried through the stack items
  that UndoManager generates. It is never read from y-tiptap's copy, which a
  plugin's appended transaction makes wrong; Yjs alone would map the current
  selection, and a moved range has just been removed. Redo and a caret keep
  y-tiptap's mapped selection. After typing over cells, Redo can keep the restored
  cell rectangle when its saved caret no longer resolves; a subsequent Backspace
  therefore clears those visibly selected cells. This is accepted, not a promise
  that Redo always restores a typing caret. Destroying an editor only detaches it: the
  history lasts as long as the session, so a tab's undo survives its editor (the patched
  y-tiptap undo plugin neither destroys a manager it didn't create nor leaves its
  listeners on it). Only edits written through an editor are tracked, so Ctrl+Z reverts
  the writer's own and leaves peer and model edits alone. Reload resets it. A text Apply enters it as one entry, from any surface, while the
  session lives (`features/draft-review/.context/draft-review.md`); a Discard from the side, Work, tree-only Apply, and
  title changes never enter it.
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
- Writer-visible save state: an outage (`offline`)
  reads "Saved locally (offline)" until the server acknowledges every local
  change, then briefly "Back online"; "Closed" and "Access lost" always win and
  healthy sessions show nothing. Draft sessions use the same local save copy.
- Draft review paints removed base text red and inserted draft text green,
  including writer edits and formatting. Attribution is a byline/membership
  overlay; it never chooses a third paint colour or splits boxes.
- Keep the custom `math_display` node; do not install TipTap mathematics nodes
  that are absent from the shared schema.

## Interaction mechanics and recovery

`patches/prosemirror-view@1.42.9.patch` adds `selectionForDOM`, an optional native
caret projection used by object physics. ProseMirror owns placing the caret and
recording it with its DOM observer; application code must not write a second
native selection or call the private observer. Native placement and orientation
comparisons share one accessor, while visibility, node styling, commands and
clipboard use the model selection. See the [object input contract](../objects/.context/CONTEXT.md#typing).
Keep the source, ESM/CJS runtimes and both declarations in the patch aligned.
Replace this patch when upstream provides an equivalent hook; a dependency upgrade
must recheck the native-selection readers and browser verification, not merely
make the diff apply. The [upstream proposal](https://github.com/haowjy/meridian-flow-docs/blob/a9d5e8706fa7f459f3c79b102f00281e1be0b5f2/work/native-composition-restart/upstream-proposal.md) is prepared but not submitted; the replacement tracker needs an authenticated account.

Keep interaction policy centralized: a new surface must use these seams rather than add a competing
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
  edge. **The document's end is one place** however the writer reaches it:
  Ctrl/Cmd+End, a press below a last block that isn't prose, and an arrow off
  the last block all go through `documentEndTransaction`. After a table, figure,
  rule or other block object that is the gap cursor. After a fence or diagram,
  which no gap cursor can follow, it is a new empty line, the only way to reach
  that spot. `exitFence` builds it, the same line the fence's own ArrowDown and
  Enter make, in the fence's quotes and list item. The line is written by that
  one action, never kept as a standing trailing node: a standing node would be
  written by every client on every load; this one only by the writer who acts.
  So one undo removes it, a document already ending on an empty paragraph gets
  the caret there, and two writers pressing at once get two lines (both writes
  kept). A press
  never makes a paragraph anywhere else, and a press in a cell never makes one.
  Ctrl/Cmd+Home goes to the gap cursor before a table or object that starts the
  document (`documentStartTransaction`). A press that lands
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
  `Can’t drop here` while dragging, and so does a picture that can't stand at the
  caret. A drop never changes
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
  that would be left empty. A block its parent can't lose (the last block, or the last paragraph in a table cell) stays,
  emptied; a fully covered table leaves as one block. A move inside one
  textblock, a node move and a `CellSelection` still use `deleteSelection`.
  Several carried lines land at a gap: before the landing textblock at its start,
  after it at its end, or at a split inside it. The slice closes into blocks and
  ProseMirror fits those blocks where the schema requires it. List items and quoted blocks are
  sibling blocks and keep their order and their depth relative to each other; a partly dropped
  item stays an item, a partly dropped quote stays quoted, and the run is nested where it lands
  like a paste (below). A whole top-level textblock keeps its type; a top-level
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
- **Lists and quotes are attributes** (`extensions/nesting/`, rules in the flat model design
  section 4). A quote is a `>` step in a block's `path`: `toggleQuote` (toolbar, block menu, slash
  menu, Mod-Shift-b) puts the selected blocks in a quote of their own inside the containers they
  share (`sharedSteps`), and writes `|` so a quote just above or below stays separate; off takes
  them out of the innermost quote they share. `> ` quotes one level deeper each time, as Markdown
  reads it. The draw plugin gives each nested block its indent, its marker's offset and one bar
  per quote; blocks of one quote meet through padding, so a bar runs unbroken.
  Enter, Backspace and Mod-Enter register on the kernel at `document` scope, narrowed to
  prose in the document or a cell, and decline wherever ProseMirror's own key is right; an
  open menu's Enter outranks them. Enter splits with the block's nesting (no `|`, no
  `start`, `done` becomes `todo`) and lifts an empty block; Backspace at an item's start
  drops its marker so it joins the item above, and lifts a first item. A paste or drop is
  nested where it lands (`landSlice`, called from `sliceForDestination`): a block with a
  list level of its own lands beside the caret's item, any other takes the caret's item
  kind and task state. A copy detaches its blocks (`copiedSlice`), and words from inside one
  block carry no list. Clipboard HTML is nested on the way out (`NestingDOMSerializer`, the
  serializer the link clipboard plugin owns) and flattened on the way in (`flattenDom`,
  inside the paste sanitizer, before it drops list and quote elements; only the `data-`
  values it writes survive). Pasted lists merge with a list beside them; two pasted quotes in a
  row stay two (`|>`). A pasted item replaces an empty line instead of merging into it.
- **A block changes type in one place** (`extensions/block-type.ts`): it keeps its `id`, its
  nesting attributes and every other attribute the new type also has. The `#`/fence input rules
  (`blockTypeInputRule`, never TipTap's `textblockTypeInputRule`), `setParagraph`,
  `setCodeBlock`/`toggleCodeBlock` (toolbar, Turn into, block menu), the fence's own Backspace
  and the slash menu's conversion of an empty block all go through it; ProseMirror's
  `setBlockType`, TipTap's `setNode` and `clearNodes` build from defaults and drop both. So a
  heading in a list item stays an item at every door; `setList` on a heading is the one
  exception, making a body-text item. A slash insert lands after the list the caret's block is
  in, inside the quotes around it (`afterList`); leaving a fence lands its new line where Enter
  would (`landAt`). Questions about a block's place go through `nesting.ts` (`readPath`,
  `isNested`, `isListed`, `isBodyText`), never a test on the `path` string.
- A node view that hides its own text derives that face from the selection and
  never restructures around it. A caret inside a rendered diagram fence shows
  the source face without changing selection, whether it arrived by key,
  command, peer write, or pointer.
- The `@` lane keeps spaces inside a nonempty multiword query, but whitespace
  immediately after the triggering `@` makes that occurrence literal.
  Eligibility reads document text; do not replace this rule with
  `allowSpaces: false` or a Space key handler.

### Live session teardown

- A session holds the writer's undo (`session.history`), so teardown ends it. When no host holds
  a live session whose room still takes writes (`canDeliverUnsentEdits()`) and its history has
  entries, the registry keeps it, off its socket, wherever it was shown: a side document whose
  review just ended, a closed tab, a phone sheet. An ended or read-only room's session retires,
  so the writer comes back to a fresh one. A band or card Apply puts an entry in that history, so
  this is what keeps an Apply's Ctrl+Z. An Apply hidden while an Un-Apply sent from elsewhere is
  out counts as an entry: the Un-Apply can fail and bring it back, however long it takes. At most
  `KEPT_FOR_UNDO_CAP` (8) are kept, the least recently changed retired first; a history that
  empties ends its session, and a host that takes the session back reattaches it.
- A retained session's socket is open when some owner wants it (a host is on screen, reported
  through `setHosted` / `retain`'s `detachedDocumentIds`) or it has unsent edits it can still
  deliver. One function, `DocumentSessionRegistry.reconcileRetainedSessions`, applies that on every
  retain/release, and the session's own snapshots re-apply it when the edits are acknowledged.
  Nothing else attaches or detaches a retained live session. `DocumentSession.detachTransport`
  also cancels an attach still waiting for local persistence.
- When the last host releases a live document, the registry retires its session after a
  3 s grace, unless it is kept for its undo (above). A session with unacknowledged edits is
  held first, so edits made offline reach the server without the writer reopening the
  document; once they are acknowledged it is kept for its undo or retired. Reopening takes the
  same session back and cancels the hold.
- `DocumentSession.canDeliverUnsentEdits()` says whether the wait can still end in
  delivery. It is false for a reset, unauthorized, terminal, destroyed or read-only room
  (the server drops a read-only room's writes without closing it). The live registry
  and `DraftRoomPool` both ask it; neither keeps its own list.
- A held session ends when the server acknowledges its edits, when the predicate turns
  false, when the document is removed or access revoked
  (`drainDocument`, `drainAccess`), when the account closes
  (`invalidateAll`), or after `UNSENT_EDITS_HOLD_MAX_MS` (10 min) spent connected
  without an acknowledgement. That cap is for a room that answers but never accepts; the
  clock runs only while the connection is up and restarts on each drop, so offline time
  never counts and a writer who types on a train gets delivery on reconnect, however
  long it takes. (Elapsed connected time, not a refusal count: the transport counts
  refusals for draft rooms only, and a live-room count would change every live session.)
  The edits stay in IndexedDB in every case but a removed room.
- A removed room (4208) retires at once, before an availability check can prove a
  restore and restart it. The local copy stays until the list's purge (`clearLocalCopy`).
- Restarting a removed or unavailable room cancels its pending teardown and schedules
  it again when no host retains the room.

### Unsent typing dropped

Typing that has nowhere to go is lost, and the writer is told once: one "Couldn't save" pill, with no
Copy and no words, and nothing stored. `DocumentSessionRegistry.observeDroppedTyping` calls its
observers each time words are dropped (the account lifetime shows the pill under one key, so
a repeat replaces it). A change with no words (a deletion, a format change) is dropped silently.

- **What the server has.** Each copy holds a mark in its `custom` store (`server-mark.ts`): a Yjs
  state vector of what the server is known to hold. The transport reads one off each socket's
  frames (`transport/server-has.ts`): the server's SyncStep1, every update the server sends and
  every one written to the socket. It reports the SyncStep1 at each handshake and that vector each
  time the server has acknowledged everything (`subscribeServerHas`); the session merges each into
  the mark by per-client maximum in one transaction, skipping a vector it already wrote. Per client
  the server holds every item below the mark, so the items the copy holds beyond it are all the
  server can lack. A mark too low offers words the server has; one too high would lose words, so
  nothing writes a vector no frame showed: never the document's own, which can hold a local
  peer's pending items that a server update released in the provider's transaction, which
  Hocuspocus never uploads. After each server frame, once the provider and every transaction it
  opened (a schema repair included) are done, an editable room sends what the document holds
  beyond the vector, so those items reach the server too, once that socket's SyncStep1 has
  arrived (before it the vector is partial). A payload grows the vector only by runs that continue
  from it, so structs past a gap are never counted. The check covers inserts: a vector carries
  no deletions, so a peer's deletions released by a server frame go with the next handshake.
- **A replaced room.** The server can replace a room's document with one that lacks items a mark
  counts: a restore from a checkpoint (`CollabDomain.restore`, no caller yet) installs an older
  state as a new generation, and a document with no authority head is reseeded empty. A handshake
  whose vector does not cover the mark replaces it instead of merging. The client sees a
  replacement only at its next handshake, whatever it is keyed on, so this is the same check a
  generation id would give. Items the replaced room lost and a copy still holds stay within the mark
  until then: the server had them, and the replacement dropped them. When a restore gets a
  caller, it should tell open clients, so their marks are replaced before an offline purge.
- **Who drops from the mark.** A closing or removing retirement (`DocumentSessionTeardownOwner`'s
  `retiring`) reads its copy beyond its mark (`LocalDocumentCopies.beyondMark`); the
  copy has every write of the session's by then. Not at the reset: a session kept on screen still
  shows that text, and a restore that restarts it delivers it. A session retires once. A 4409 access
  change is no reset: the room reconnects and keeps its typing. `LocalDocumentCopies.clear`, the
  only deletion on a final fact, reads each copy beyond its mark before deleting it. So typing
  from before an offline reload, in a document purged before its room reconnects, is dropped with
  the pill, and a room with no session in this tab is measured too. A copy with no mark (written
  before marks, or whose first mark write was lost) counts as marking nothing: all of it counts.
  A closed draft's copy stays for an Undo of its Discard, which delivers it.
- What it cannot reach: a read admission has no such loss (see the next section). A document no
  tab has open keeps its typing in its copy until its next open or its purge.

### Undeliverable edits (a room admitted read-only)

**A room the server admits read-only holds none of the writer's edits that the server lacks.**
It is checked at every handshake of a read admission (`core/transport/handshake-difference.ts`),
from the wire alone, with nothing stored between handshakes.

- The session (`unsent-edits.ts`) decides what counts: everything the server lacks, whoever wrote it,
  except *display writes*, what the editor binding writes while drawing (it deletes a node the
  schema can't build). A display write is told from a writer transaction by the sync plugin's own
  `addToHistory` meta. A new reader that opens a Yjs transaction through
  `readRepairedRoot` on a read-only room, with no origin, would be counted each time. The undo
  manager captures a binding write only with that mark, so repairs never land on the writer's undo
  stack (its other origins, the manager's own undo and redo, a Discard, are unchanged).
- A display write is known wherever it travels: `LocalDocumentPeers` marks the update it relays
  (the receiver adds its delete set before anything is decided) and the session records its
  display writes in the copy's `custom` store, keyed by client id and schema tag, in the task of
  the update. A reader takes the copy's updates first and its records after.
- **Typing** is what the session wrote through any local transaction that is not a display write
  and has an origin (an editor, Undo and Redo, a Discard; its ledger, by client id), plus every item of any other client id the server lacks.
- A read-admitted connection sends no Update frame; a change that is not a display write asks for
  one `forceSync`, and `serverHasLocalChanges` there is the handshake's verdict (Apply's
  acknowledgement barrier waits on it, not on a `SyncStatus` the server always answers `false`).
- **The replacement** (`DocumentSessionRegistry.replaceRoom`): the old session reads its copy and
  takes one more handshake (it can end the replacement), the typing is dropped
  (with the pill), the old session goes inert for
  good (`attachTransport` does nothing on it, so no retain, restart or pending attachment can
  reconnect it and upload the dropped words; its document stays readable), and a session on the room's *next incarnation* of
  its copy opens read-only, loading from the server. Nothing is emptied and nothing is sent to
  other tabs: the copy's database name has a trailing incarnation number (none means 0),
  `LocalDocumentCopies.current/advance` keep the pointer in `localStorage` under a Web Lock, and two
  tabs advancing at once end on the same number. The old session is destroyed when its editors
  have unmounted (`retireReplaced`, quarantined by persistence name), and its copy then goes by the
  older-copy path below, like any older incarnation: read whole against the new session's first
  handshake, so words another tab wrote into the same copy meanwhile are dropped too. Holders
  follow through `observeReplacement` (live bindings and open tabs, draft room reads); a mount keeps its
  reading position across it, because the store is keyed by room (`use-reading-position.ts`).
- **Who drops.** The replacement (`undeliverableEdits`: the typing in the handshake's difference;
  it reads that and a snapshot, then makes the old session inert), the older-copy read below
  (everything an older incarnation holds beyond the new session's first handshake), a closing or
  removing retirement and `LocalDocumentCopies.clear` (each, the copy beyond its mark). Nothing
  is stored: the copies are working storage only, and a drop that is told twice shows the one pill
  under its key.
- A session that opens a room's current incarnation reads the older ones no tab holds against
  its first handshake, drops what they hold beyond it, and deletes each one.
- Not done yet: the Discard's `returned` on replacement waits for never-refuse PR B's
  `read_only` frame.

### Draft room retirement

- `DraftRoomPool` retains stable `draft:<draftId>` rooms without leases. The last
  owner releases through a grace period; a room with unacknowledged edits drains
  before retirement. The drain ends when the server acknowledges the edits or when
  `canDeliverUnsentEdits()` turns false, read-only access included. Ordinary retirement keeps IndexedDB state. There is no
  draft-generation replacement or writer-operation handoff to a new draft.
- Terminal `4205` (`closed`) and `4208` (`removed`) end the session's transport; its cache
  stays, and a retained session stays readable until its owner releases it or a restore
  restarts it. Once its last owner releases it, it retires on the next task, not after the
  grace. A closed draft's retirement drops typing that just left the screen; a removed
  document's typing is dropped once, by `clearLocalCopy` at its purge (live copies only: a draft copy was told when its draft closed). Dropping a closed draft's typing never
  deletes the copy: Undo Discard reopens the same draft row, and the restarted session replays the
  copy into it, so the writer may see the pill and also get the words back. The copy goes with the
  document's purge. `closeDraftRoom` lets the session the pool
  holds retire as a closed draft's (the pool's `closed` set overrides whatever ended its socket)
  and, with no session, drops the copy's typing itself. A draft copy no page opened is
  found at start: once at idle after the account lifetime opens (cancelled if the lifetime
  closes), `sweepDraftCopies` lists the draft copies not yet swept and asks `POST /api/drafts/states`
  for each draft's state. A closed draft's copy is left as it is. An open draft's copy that holds typing
  beyond its mark (an Apply left the draft with no changes, so nothing lists it and nothing
  reopens its room) has its room opened through the draft pool under a `sweep:` owner until the
  server acknowledges, then released, so the typing is delivered and shows as a change by the
  writer. An older copy version's words are dropped instead. A copy another tab has open is left to that
  tab, and a copy a page in this tab opened during the sweep stays unswept. At most four copies are handled at a time. A swept copy is recorded (`meridian:copy-swept:<name>` in local storage) and
  skipped without loading at later starts until a session opens it (`hold`, a restore). A copy
  with no mark proves nothing undelivered, so the sweep skips it. The account command owner asks the server whether the draft is gone (fresh
  metadata) and handles a metadata `gone` the same way,
  whichever arrives first; see Draft end in the
  [draft-review state machines](../../../features/draft-review/.context/state-machines.md). See the
  [review runtime](../../../features/draft-review/.context/draft-review.md).
- `resetDisposition` is the session transport's terminal-state vocabulary,
  not a draft reset protocol. Schema fences, authorization loss and explicit
  session rebuild retain their own meanings; local text Discard does not retire
  the room, selection or UndoManager.
- A draft update refusal (`1008`) is bounded: after three consecutive refusals
  without acknowledgement, the transport ends `DRAFT_UPDATES_REFUSED`
  (`updatesRefused`). A retained room stays open read-only with the unsent text on
  screen: `readDraftRoom` keeps it as `fenced`, and the status says "Couldn't save
  your latest changes" with Try again, which rebuilds the room from IndexedDB and
  resends the edits. It never retries on its own. A `4207
  draft-prefix-missing` close is an ordinary reconnect, not a refusal. The next
  handshake's SyncStep2 supplies missing bytes before held keystrokes.
