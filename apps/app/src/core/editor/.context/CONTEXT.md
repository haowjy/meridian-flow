# App editor runtime contracts

This page covers contracts that cross the TipTap, Loro, session, and feature
boundaries. The app schema must remain structurally aligned with
`@meridian/prosemirror-schema`; schema drift can corrupt shared documents.

## Sessions and local copies

`DocumentSessionRegistry` (`document-session-registry-implementation.ts`) owns the account's
document sessions: one per room, keyed by `sessionRoomKey` (the bare document id for a Live room,
`fork:<draft>:<document>` for a draft's fork room), held by retain/release, closed after a grace
once no host wants it and its unsent edits are acknowledged. A lease is only the account's right
to hold one room's session (`{accountId, projectId, documentId, room}`): nothing orders or fences
it, because the project's list says whether a document is there.

A fork session (design §6, "The session lifecycle") is the same `DocumentSession` class on the
fork room, built over its document's Live session: its docs are `RoomDocs.draftOf` the Live
copy, it has its own socket, store, presence and `UndoHistory`, and it registers its docs with
the binding (`registerDraft`) so every batch the Live session imports, and every local write it
publishes (`forwardLocalWrite`), forwards the fork, whether or not an editor shows it. Admitting a
fork admits its Live room; the Live room counts as retained while any fork session of it lives,
and is torn down after them (`clearLocalCopy` and account close retire forks first). A draft
page opens its fork room whether or not the draft has changed the document: there is no path that
binds Live and swaps at the first keystroke. A document the draft created has no fork: its page
binds its own Live room.

A session owns one `RoomDocs` (the structure doc and one `LoroDoc` per textblock, local-first
design §1) and frees it at teardown; nothing else frees it. Every local write leaves by one path,
`publish`: appended to the IndexedDB copy, posted to this browser's other tabs
(`BroadcastChannel` named after the copy), then sent to the server. Every peer's batch, from the
server or another tab, arrives by `importRemote`, which calls the binding's `importRemoteUpdate`
and so goes through its composition guard: a batch is held, as bytes, while any editor on the
room is composing.

The browser's local copy of a room is the IndexedDB database
`documentSessionPersistenceKey(accountId, room)` (`local-document-copies.ts`, store layout in
`local-copy-store.ts`): a snapshot per doc key, a log of envelope batches folded into snapshots
every `COMPACT_EVERY` batches and at open, and a `meta` store holding the room version the server
is known to hold (`SERVER_META`). A fork room's copy is named under its document's, so a document's
copies (Live and every fork) are found and deleted together. It is
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
The tab that holds it clears the copy itself when it reads the same `purge`; a tab whose copy
another tab deletes stops writing to it on IndexedDB `versionchange`.

A document made in this browser has its session in the registry from the start, under its final
id; there is no handover. Its room connects once the server has the `create` (a Join for a
document the server does not know yet errors non-terminally, and the transport rejoins).

The production registry has one immutable account epoch. Account close refuses new work
synchronously, then drains transports and leases.

## Mount and collaboration

- `createEditorExtensions()` is the sole collaborative assembly point. TipTap
  and `buildDocumentSchema()` are built separately, so adding a node or
  attribute requires parity in both. The binding is `loroSyncPlugin`
  (`extensions/loro-sync.ts`), over the session's `RoomDocs`.
- The binding rebuilds only the blocks a remote batch touched and dispatches them as one
  transaction marked `setMeta(loroSyncKey, REMOTE_META)` and `addToHistory: false`. Code that
  must tell a writer's move from a remote write reads that meta; `notifyChanged` (a write made
  outside the editor, an Undo, a `writeDocument`) dispatches the same way.
- Review changes (`extensions/review-changes`) is decorations only: Live's text of a changed
  paragraph is a widget, never document text, so typing, Undo and the binding see the draft alone.
  Its rows are read 150 ms after typing pauses (`changedBlocks` of the fork against Live) and its
  decorations map through the typing in between: reading on every key costs more than a key may.
  The host turns it on and off with `setReviewChanges`; a plugin's config change needs a reload in
  dev, since HMR keeps the plugin instance. `KeptExtension` is the one quiet mark on text kept in
  place: a block someone deleted that the binding keeps while the caret is in it (`loroSyncKey`
  state `kept`), and for 4 s each edit an Undo or Redo left because it was written over
  (`HistoryRun.kept`, `showKept`), naming the writer when their copy's presence says who. The press
  Undo's stayed rows (second round) are to go through `showKept` too.
- Block ids: `extensions/block-id` edits each local transaction in flight (`filterTransaction`,
  not `appendTransaction`, which would reset the input rule it follows and with it Backspace's
  undo of the rule). The block the old document had at that place keeps its id; a split's other
  half, a pasted copy and any block with none get a fresh one; a cut block's id is free, so a
  paste or drop keeps it. The fixer leaves a container's empty paragraph `<container>/empty` to
  the binding (either filter may run first): that id is a placeholder no block is stored under,
  and the binding gives the paragraph a fresh id in the same transaction once it is typed in,
  split, or moved out. The first character typed there is usually inside an IME composition, so
  the paragraph's node view (`MeridianParagraph.addNodeView`) sets a changed id or attribute on
  the element it has instead of ProseMirror replacing the element, which would commit the
  composition's raw keys as a stray letter (`k` before `かな`); only a level that changes the tag
  rebuilds it. The id rides the clipboard as `data-block-id`. Remote transactions
  are left alone: their blocks already have ids. A block's id is its text doc's key, so a block
  is found by id (`findBlock` in `loro-points.ts`), never by a stored position.
- Caret across a remote write: the binding carries the selection as Loro cursors. A
  `NodeSelection` that still selects a node after mapping stays one. When the block a cursor was
  in is gone (a peer deleted it while the writer composed in it), the caret goes to the nearest
  position before where the block was; typing composed into it stays in its text doc, hidden
  with the block.
- `EditorMountIdentity` holds every construction fact. `editorMountKey()` becomes the React key,
  with the session's peer id appended, so a replaced room remounts TipTap.
- `useMountedEditor()` freezes construction options, binds through the session,
  and owns destruction. It applies editability and `editorProps` to the live
  instance. A new construction dependency belongs in the identity type, not an
  effect dependency list.
- The editor binds one session's docs: a Live room's, or a draft's fork room's, which reads Live's
  text for every block the draft has not written. No suggestion marks or attrs exist (schema 4.0.0).
- Builds on Yjs kept document copies in IndexedDB; `core/stale-yjs-copies.ts` deletes them once
  per signed-in load (`routes/_authenticated.tsx`).

`DocumentSession` status combines persistence and transport: `detached`,
`syncing`, `synced`, `offline`, `access-lost`, or `destroyed`; `schemaFence` is
orthogonal. `synced` means the transport's Join completed, not that all
local edits are saved. `serverHasLocalChanges` is true only after that Join and every batch
sent on the current connection is acknowledged (see
[`../../transport/.context/CONTEXT.md`](../../transport/.context/CONTEXT.md)).

Before binding, `EditorView` waits for local persistence. Verified detached
content may bind without first server sync; other sessions use the existing
overall timeout, whose expiry permits degraded evidence but not upload
authorization.

## Presence

Local presence is owned by `local-presence.ts`, on a Loro `EphemeralStore` keyed by the
session's peer id; the transport relays it on the room's ephemeral channel. Extensions receive
`setField`, read-only peer state, and a caret facade; they never receive the mutable store.
Suspension publishes null while retaining the desired map, nested suspension republished only at
the outer boundary. A second presence write path creates ghost carets. `detachTransport` holds
one suspension and the next attach releases it; the session also suspends on `pagehide` and
resumes on `pageshow` only if it holds that suspension.

## Anchors and holds

A remote write can move or replace any block. Long-lived UI uses `EditorAnchor` backed by Loro
cursors (`loro-points.ts`: `pointAt`, `resolvePoint`, `EncodedPoint` for storage), resolves it
at use time, and validates the object found there. `NodeHold` adds the node's block id and
type: a node with an id resolves by id, so a deleted node releases rather than retargeting a
replacement; an inline atom with no id resolves by the seams around it. `carryAnchor` is used
where plugin `apply` runs before the binding settles; read resolution happens later. Every
resolution is bounds-checked.

DOM elements are geometry only. Node views and decoration spans can be rebuilt
without content moving, so a surface drops elements after measuring and holds
identity in anchors or holds.

## Editor policy seams

- Disable TipTap's trailing node and local undo defaults where collaborative
  behavior supplies the contract. `editor-history.ts` is the document's history: its
  `DocumentHistory` is owned by the `DocumentSession`, and each editor attaches to it while
  mounted. It wraps the binding's `UndoHistory`, which the sync plugin records every write into:
  one Loro `UndoManager` per text doc the tab changes (made at its first write, through
  `RoomDocs.beforeTextWrite`), each Undo item tagged with the editor step
  it belongs to. Ctrl+Z runs exactly the managers the newest step touched until their top item
  is another step's, and publishes what they wrote as one local batch. Loro keeps each inverse
  as positions moved through every edit since and records only this peer's commits, so a chain
  of dependent steps (Enter, Backspace, paste; bold, unbold) undoes and redoes exactly, and
  Ctrl+Z takes back the writer's change and leaves a peer's or the model's alone. Writes closer
  than `GROUP_MS` join one step. A step closes on `endUndoStep(state)` (image upload, link
  actions, `@` references, reference drops, a block drop call it before their edit) and on any
  document-changing transaction marked `addToHistory: false`, which commits under
  `UNTRACKED_ORIGIN`, as `session.writeDocument` does; meta-only transactions are not
  boundaries. Undo puts back the selection the step started from, as Loro cursors the manager
  carries through its inverse (a deleted selection comes back over the restored text); Redo puts
  back the one Undo was pressed from. Structure values (order, parent, node type, attributes,
  comment bodies) are not Loro's: each step keeps the values it set. A step goes back whole or
  stays whole (design §2, "An Undo takes an edit back whole"): when another peer wrote over any of
  it (a key, the new half of an Enter, a word it typed, a style it set), Ctrl+Z leaves it, writes
  nothing, drops it and every step sharing its paragraphs from the history, and goes on to the
  step before; `run`'s result counts the steps that stayed, and what the app shows for them is
  open (design §9). Typing joins the open step; any other write starts one, and a write that sets
  structure ends it, so an Enter is a step of its own. Destroying an editor only detaches it: the history lasts
  as long as the session, so a tab's undo survives its editor; the session frees its managers
  before its docs. Reload resets it.
- Slash is one spec over the shared suggestion lane. Its predicate is the whole
  trigger envelope; insertion strategy determines target, schema availability,
  and caret placement. A pick in a table cell remains in that cell. Image picks
  hand an anchored target to the image lane.
- Autoformat uses inherited TipTap rules plus explicit local fence and recovery
  behavior. Auto-pair owns only its declarative character table; Markdown
  delimiters remain input rules. Do not duplicate either mechanism.
- Passage navigation retains a
  session until mounted-editor acceptance, uses block identity plus text, and
  refuses ambiguous fallback. It acquires one exact container registration; hiding, holding, replacing, or
  destroying that editor revokes the target and ends the jump without
  reacquiring another editor.
- Search-passage navigation lands by block hash (a prefix of
  `fullHashForBlockId(id)` from `@meridian/agent-edit`, which must match exactly one block) plus
  the matched term, in three outcomes: the live block still holds
  the term (mark it there), the term occurs exactly once in the document (mark
  that), or `stale`, which shows a notice. Never land on a choice among
  duplicates: a nearby-but-wrong paragraph is worse than saying nothing was
  found. The highlight is never a selection, clears on the writer's next edit or
  caret move (not on remote transactions), and its notice expires by
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
  healthy sessions show nothing.
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
keyboard, pointer, drop, or recovery answer.

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
  so the writer comes back to a fresh one. At most
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
  asks it and keeps no list of its own.
- A held session ends when the server acknowledges its edits, when the predicate turns
  false, when the document is removed or access revoked
  (`drainDocument`, `drainAccess`), when the account closes
  (`invalidateAll`), or after `UNSENT_EDITS_HOLD_MAX_MS` (10 min) spent connected
  without an acknowledgement. That cap is for a room that answers but never accepts; the
  clock runs only while the connection is up and restarts on each drop, so offline time
  never counts and a writer who types on a train gets delivery on reconnect, however
  long it takes. (Elapsed connected time, not a refusal count.)
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

- **What the server has.** Each copy keeps the room version the server is known to hold
  (`SERVER_META` in the copy's `meta` store). The transport knows it per connection: the
  server's Join version, merged with each batch the server acked or sent
  (`serverVersion()`); the session writes it to the copy each time the server has acknowledged
  everything, merging by per-peer maximum. Ops the copy holds beyond it are all the server can
  lack. Whether those hold words is `unsent-words.ts`: it reads the text inserted beyond the
  version in each text doc; a change with no words is dropped silently.
- **Who drops.** A closing or removing retirement (`DocumentSessionTeardownOwner`'s `retiring`)
  reads its copy beyond its mark (`LocalDocumentCopies.wordsBeyondMark`); the copy has every
  write of the session's by then. Not at the reset: a session kept on screen still shows that
  text, and a restore that restarts it delivers it. A 4409-style access change is no reset: the
  room rejoins and keeps its typing. `LocalDocumentCopies.clear`, the only deletion on a final
  fact, reads each copy beyond its mark before deleting it. A copy with no mark counts as marking
  nothing: all of it counts.
- What it cannot reach: a document no tab has open keeps its typing in its copy until its next
  open or its purge.

### Undeliverable edits (a room admitted read-only, or ended below its history)

**A room the server admits read-only holds none of the writer's edits that the server lacks.**
At a read admission the session asks whether its copy holds words beyond the server's version
(`undeliverableWords()`); a room the server ended below its history cutoff (`historyCutOff`)
holds them by definition. Either way the registry replaces the room
(`DocumentSessionRegistry.replaceRoom`):

- The typing is dropped with the pill, the old session goes inert for good (`makeInert`: no
  transport, no tabs channel, so nothing can upload the dropped words; its document stays
  readable), and a session on the room's *next incarnation* of its copy opens, loading from the
  server. The copy's database name has a trailing incarnation number (none means 0);
  `LocalDocumentCopies.current/advance` keep the pointer in `localStorage` under a Web Lock, and
  two tabs advancing at once end on the same number.
- The old session is destroyed when its editors have unmounted (`retireReplaced`), and its copy
  then goes by the older-copy read: a session that opens a room's current incarnation reads the
  older ones no tab holds once it has joined, drops what they hold beyond it (with the pill), and
  deletes each one. Holders follow through `observeReplacement`; a mount keeps its reading
  position across it, because the store is keyed by room (`use-reading-position.ts`).
- A fork session reads through its Live session's docs, so replacing a Live room rebuilds every
  fork session over it on the fork's same copy (its own words are intact), and the old Live
  session retires only after the old forks have: the same forks-first order as `invalidateAll` and
  `clearLocalCopy`. The rebuilt forks reach their editors through `observeReplacement` too.
- A read-admitted connection sends no `DocUpdate`. Nothing is stored about a drop: the copies are
  working storage only, and a drop that is told twice shows the one pill under its key.
