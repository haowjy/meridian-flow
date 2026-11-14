# Tree interactions

Reference detail for Context-tree interactions. Read [CONTEXT.md](CONTEXT.md)
for feature-level contracts first.

## Shared nested rows

The sidebar's sources, on desktop and in the phone's drawer, render ordinary nested
folders through `TreeChildren`. Search supplies visible ids
with ancestor closure, not a filtered tree: rename and move free-name predictions
always see all siblings. Search disclosure is temporary; it never overwrites
the normal expansion state. A newly created Work note stays visible for naming
even when its name does not match the search.

Indentation counts visible expandable parents, not tree depth: standalone
lists start at zero; rail sections start at one. The shared
`TreeGroup` spans all visible children, including Earlier notes and the current
Work’s separate tree. It paints its parent guide above row highlights without taking pointer
input. Section headers and folder rows use the same disclosure-center geometry.

The chat Files menu combines this same shared Scratch browser with chat-owned
uploads. Scratch queries wait for resolved Work/lineage authority; an unresolved
owner never falls back to a project-wide query. There are no thread folders or
folder-to-chat actions. The sidebar and Files menu use `ChatScratchTree`,
including its read-only Earlier notes navigation and per-owner capabilities.

## Inline name form semantics

Create and rename adapt `useInlineEdit` (`components/ui/use-inline-edit.ts`),
the protocol every in-place edit in the app shares; `EntryNameField` renders
the field with its floating validation note.

**Submit:** Enter or blur commits (unless pending or error-blocked). Escape
cancels. Empty or unchanged input = cancel. IME composition keys are ignored.
Blocking errors refocus the input; a failed mutation stays open with its
message.

**Focus:** Auto-focus on mount. `requestAnimationFrame` retry handles Radix menu
focus-scope teardown — the menu's closing animation holds focus for one frame,
swallowing a same-tick `focus()`.

**Adapter differences:**

| Concern | `useCreateEntryForm` | `useRenameEntryForm` |
|---|---|---|
| initial | `""` | `entry.name` (or the failed repair name) |
| unchanged | — | current name |
| validate siblings | all sibling identities and kinds | syntax only; the list numbers a taken name |
| select | — | the part before a visible extension; all of a prose name |

Names are compared and submitted as the contracts codec stores them
(`storedFilename` in `context-entry-name.ts`), given the row's own
facts (`NamedRow`: its stored `extension` and whether it is `editable`, never read from
the suffix): a prose name has no extension, so `Chapter 13.md` typed on `Chapter 13` is no change and
beside `Chapter 13` predicts `Chapter 13 (2)`; a bare name keeps the renamed file's visible
extension (`settings` on `config.toml`). Siblings of either kind compare by their literal rendered names. Create conflict copy names the occupant's kind, not the requested kind. Rename and move never block on a sibling claim: the shared allocator predicts the landed name for the warning, and the list numbers it when the record is written (rename, create) or when the replay shows it (move). The codec's `invalid_name` message
shows on the field. A rename sends the stored name (`storedFilename`) and the type it changes to, if any; a canonical name is never fed back into extension inheritance.

## Dual-trigger caveat

A row's right-click menu and its ⋯ are one `RowMenu` (`components/ui/row-menu.tsx`): plain data
(groups of items, an Import… submenu, the `empty` line) that `ListRow`'s `menu` renders through
both Radix primitives, `ContextMenu` on the whole row and `DropdownMenu` on the ⋯. `useEntryMenu`
turns the row's `EntryAction`s into a `RowMenu`; context types don't cross into `components/ui`.
The ⋯ is a dense `IconButton` (24 px box, 44 px hit area under a coarse pointer), so rows with and
without one stay the same height, and it is named "Actions for {name}". It stays visible while its
menu is open. Labels, icons, grouping, destructive metadata, order and dispatch can't drift between
the two triggers.
`EntryAction` is one ordered list: New file, New folder, Import…, separator, Rename, Move…,
Copy to…, Delete, Restore (creation first; Restore is a Trash row's only action), identical in
both triggers. Each row declares which of them it supports. `useEntryMenu` builds a row's menu for
both triggers. Opened on a row inside a selection of two or more rows, the menu is the selection's,
a second ordered spec through the same renderers: Move N…, Delete N, Restore N, each only when every
selected row grants it, named by the selection's kind ("Move 3 files…", "Delete 2 folders", "Move 4
items…" for a mix). A row's grants (`SelectionGrant`) are its own menu actions: `useEntryMenu`
registers them with the selection, so a row passes its actions once and the selection's menu can't
disagree with the row's. A selection whose rows share no action shows one disabled line in its list's
verb ("Can't move or delete all of these"; in Trash "Can't restore all of these") rather than an
empty menu.
Opened on a row outside the selection (or alone in it), the menu selects that row alone, as
Finder and VS Code do, and is the row's own. The selection is read once, as the menu opens, so the
action acts on what the label counted. The context-menu key and Shift+F10 fire the same
`contextmenu` on the focused row; there is no Delete-key shortcut for rows. Escape inside an open
menu closes only the menu: the list's Escape clears the selection only for keys pressed in the
list itself, since a portaled menu's key events still bubble to it. Actions dispatch through `useMenuActionDispatch`
(`components/ui/dropdown-menu.tsx`): they run once the menu has closed and put
focus back on its trigger. Run from the item, menu teardown would blur a freshly
mounted inline row (blur commits or cancels it), and a dialog the action opens
would return focus to an item that is gone.

## Creation targeting

One required `TreeCreationRequest` serves every entry point:
`{ scheme, kind, parentPath }` (`TreeCreationProvider` request, or the phone
drawer's controlled mirror), with `""` meaning the scheme root. Scheme headers request the root; a folder
row requests itself; a file row requests its parent
(`parentContextEntryPath`). The single `TreeChildren` renderer inserts the
inline CreateRow at the target; the root calls it with an empty child list
before fetch, while nested folders use the same mount at child depth. Creation
explicitly reveals every target ancestor in the stored expansion model before
the request starts. Clicking any scheme or folder disclosure while the row is
open cancels creation and then performs the requested toggle; disclosure clicks
must never feel inert. Sibling-collision
validation uses the target folder's children. The rail's Files tree lists the project's own areas (Manuscript, KB, Unfiled) and User sits docked below it; creation in either is never Work-scoped: Scratch notes are made only from a Work's Files tab (New note) and by the AI, and Uploads are intake only (`schemeAllowsCreation`). Starting a creation anywhere
replaces a pending one; Escape/blur semantics are the shared
`useInlineEdit` contract.

## Deleting

A row's Delete, a selection's Delete N and a drop onto Trash are each one `runDelete`
(`entry-drag/entry-failure.ts`): a `delete` record per entry, appended to the browser's copy of the
list that holds it (`TreeActions.remove`, one update per list). The row leaves the tree at once and
the document waits in Trash. One own removal covers every document the gesture takes away, and an
entry inside another entry's folder goes with that folder, never on its own. A list that cannot
take the records (read-only, not open) toasts and keeps the documents. A delete the server refuses
comes back as a `refused` settlement: the row returns with `NamespaceFailureMark` ("Couldn't
delete this document." and the server's reason) and its menu offers Delete again or Dismiss.
Writer deletion has no confirmation step. Its notice ("Chapter 2 deleted.", Undo) is the Discard
notice line, held in `DraftNotices` under `deleteNoticeKey(projectId)`: in the sidebar for a
delete made there, on Recently opened for one made there, and on the page main goes back to when
the delete took main's document. Its Undo and the sidebar's Ctrl+Z are one step
(`core/project-tree/tree-undo.ts`).

Inline create puts its naming row at the end of the folder, where the create appends, so nothing
moves on Enter. The source header's New file and New folder name the folder the writer last
opened or closed into, else the open document's folder, else the top.

## Downlinks

- [Server context domain](../../../../../../../apps/server/server/domains/context/AGENTS.md)
- [Desktop project shell](../../.context/CONTEXT.md)
- [Mobile project shell](../../mobile/.context/CONTEXT.md)

A rename is a `rename` record, appended at once (`useRenameEntryForm`, `TreeActions.rename`): the
list numbers the name when the clash is visible in its copy, and the tree, headers, tabs and routes
show the new name from the same replay. Nothing is sent or retried by the UI: Yjs carries the record.

A refusal comes back as a `refused` settlement on the record, and `treeFailures`
(`core/project-tree/tree-failures.ts`) puts it on the row as `TreeFailure` fields:
`namespaceFailure` (`delete`, `set-location`, `create`), the server's `failureReason`, the repair
(`namespaceRepairName` for a rename, `namespaceRepairMove` for a move) and `failureRecord`. The row
returns to where it was with `NamespaceFailureMark`; the identity bar of a homed document shows a
passive status directing the writer to Rename in the file list. The list's repair field opens once,
as the refusal arrives (`use-repair-on-fresh-failure.ts`): a failure already there on mount, a
remount, or one that lands while another input is active leaves only the mark; blur dismisses the
field without retrying and Enter retries. A later record of the writer's on the node ends the
failure, which is the repair. The row menu's Dismiss (`dismissFailure`) puts a refusal away without
repairing it; it stays in the list and no longer shows.

A document whose create the server kept in Unfiled stands there with its text and the same mark
(`namespaceFailure: "create"`, "This document couldn't be created where you put it." and the
reason). Its row menu repairs it: Move… offers the place the writer asked for
(`namespaceRepairMove`), Rename the name.

A move or rename shows no "Updated N links" line: the links name the document's id, which does
not change, and a record has no receipt to carry the count.

## Move and Copy picker, and Scratch rows

Move… follows Rename in the shared action specification, including phone actions,
and Copy to… follows Move…. They are one component:
`EntryDestinationPicker` takes an `action` ("move" or "copy"), the row it opened from, and,
for a selection's Move N…, the `selection` it moves. A selection moves together, minus rows inside
a selected folder, skipping rows already in the destination; it offers no position choices, reads
"Already in <folder>" only when every row is already there, and keeps the moved rows selected with
focus on the first in its new place (the row the picker opened from may have moved and unmounted it).
The rows arrive over several commits, and a keyed reorder blurs a focused row without remounting it,
so for two seconds after a Move the list puts focus back on its first selected row whenever focus
is lost or sits on another selected row (`settleFocus`).
Both offer the same destinations, and a folder cannot go inside itself in either.
They differ in what a pick does: Copy to… has no "Already in" refusal and no
position choices (it always adds, and its copy takes the next free name in the
parent the row is already in), and it calls `copyRows` where Move… calls `moveRows`.
`EntryDestinationPicker` mounts `useProjectMenuSource` and `DrillInMenu` only while open; closed rows keep only their stable row anchor. It starts inside
the current parent for a new move or copy (at the project's root when no area is given). A retry opens at the refused destination
when it still resolves (matching owner and full path), otherwise at the
current parent with the refusal message. It disables files and the moved folder's subtree, and offers no
commit at the area list. In the current parent the action is "Change position", which
opens the places among its siblings in place of the tree (`DrillAction.choices`): the top, after each
sibling, the bottom, read from the tree's complete sibling order (`children`, not what a search
shows), without the place it already holds. It reads "Already in <folder>" only when the entry has no
siblings. The phone uses the same picker; it has no drag.
A taken name never refuses: the row arrives at the next free name (predicted
from the destination's rows, decided by the server) through `setLocation` for
files and `setFolderLocation` for folders. Before the click, a Move action carries a
warning line under it ("chapter-1 will be renamed chapter-1 (2)", the `note` of a
`DrillAction`): a move renames something the writer already has, and until tree
Undo exists dragging it back doesn't restore the name. A Copy shows none, since
nothing the writer has changes. Either pick opens the destination folder.
Trees span areas, so menu lookups check source identity as well as entry identity; equal paths in
different areas remain distinct destinations.

Move… and dragging share every step. Refusal is judged by identity from the trees the list
shows (`moveRefusal` in `entry-drag/move-plan.ts`: a folder over itself or its own subtree, a row
already in the parent), so the picker and a hover agree even while a peer moves rows. A ready
plan contains rows with their `TreeDestination` (`{ parentId, index? }`, the folder's id or the
source's id at the top); hover prediction and `moveRows` consume those rows without resolving the
destination again. `moveRows` (`entry-drag/execute-move.ts`) appends one `move` record per row to the
list that holds the row (`TreeActions.move`) and returns which rows moved and which no list could
take. A move sends no name: the replay numbers a clash, and `renamesOnArrival` only predicts it
for the warning shown before the drop. A positional destination (an edge drop, the picker's
"Change position") is an index among the destination's children without the carried rows, so a
same-parent placement is a reorder rather than "already there". A move between the account's files
and a project is not a record the browser can append to two lists; the drop offers Copy there.
Copy stays a server route: `copyRows` (`entry-drag/execute-copy.ts`) mints the copies' ids and the
command's id, sends them once, and the copies arrive through the list. A refused Copy toasts with
Retry.

The chat's Scratch renders one owner-bound `TreeEnvProvider` and `TreeChildren`
per real tree. Earlier notes is a navigation disclosure outside the second
lineage tree, not a menu-node projection or a mutable folder. Selected
files open directly with their known owner. Rename, Move… and Delete share the Files implementations through
`useEntryInteraction`, the row boundary for management state, dispatch and
operation selection. Creation is absent. One surface-owned deletion coordinator
and dialog serve all Scratch rows, retaining each target's owner. The actual owning Work determines editability (`useWorkSourceWritable`, the one answer for a Work's source, which the sidebar's Scratch pane reads too); an archived, deleted or unlisted Work's Scratch remains navigable, its rows offer only Copy to…, and its area is not `writable`. Shared rows receive explicit action capabilities from their surface. The synthetic
"Earlier notes" group is navigation only, not a mutable folder.

## Selecting and dragging rows

The sidebar's sources, a chat's Files-menu Scratch and a Work's Files are each one list:
`useEntryList` owns its selection, its entries route and, through `EntryList`,
its drop scope. Recently opened (main's landing) is a list too, with its own
`useEntrySelection` and no drop: its rows are `ListRow` links whose drag carries the selection as
references (`useEntryRow` with `source: "reference"`), so Ctrl/Cmd-
and Shift-click are taken in the capture phase (`useEntryRow().select`) before the link would open a
browser tab, and the row's ⋯ and right-click give Move… and Delete for a filed document (the same
`useEntryMenu`, `EntryDestinationPicker` and `useDeleteContextEntries` as the tree). An Untitled
row, or a Scratch note (the list doesn't know its owner), grants nothing. The sidebar's sources (also the phone drawer) are one list over every
tree they can show: Manuscript, Knowledge, Your files and Unfiled, each tree keeping its own
expansion. Rows join through `EntrySelectionProvider`.
Selection keys are `kind:id` and carry no scheme or place, so a moved row keeps
its key and stays selected. Rows a delete or restore takes out of their list leave every list's
selection (`leaveSelections`, run by `runDelete` and both Trash restores), with the documents and
folders inside a deleted folder: Trash rows share the `file:<documentId>` key, so a row deleted while
selected would otherwise arrive selected in Trash, and a restored one back in the tree. A plain click opens or toggles the row as before and leaves no
selection of its own: until the writer Ctrl/Cmd- or Shift-clicks, the selection
is just the open row, shown by the open row's own highlight. Ctrl/Cmd-click
starts an explicit selection from the open row and adds or removes rows;
Shift-click selects the on-screen range from the last clicked row, read from the
DOM (`data-entry-key`) so it always matches what is visible; Escape returns to
the open row. Explicit selections and the open row share the selected fill
(`role.selected`, ink, never jade); the open row stays findable inside a
selection by its weight. Adjacent selected rows join into one block rounded only at its ends:
after each commit the selection marks each row's place in its run
(`data-selection-run`) in one pass over screen order. The same
modifiers with Enter or Space select from the keyboard, and a selected row
reports `aria-pressed` (rows are buttons, not tree items, so that is the state
they can carry).

Dragging a selected row carries the selection in screen order, minus rows inside
a selected folder; dragging an unselected row carries only it. Each row carries
what its surface grants (`EntryGrant`: `move`, `copy`; an ended Work's Scratch
grants Copy, not Move), and a drag starts when the row has either. A selection
that holds a row without the grant an action needs, or one that lost a row (a peer
deleted it, or its parent isn't known yet), does nothing for that action rather
than silently dropping rows. `drag-session.ts` holds the drag (a browser hides drag
data until the drop). The transfer carries only Meridian's entries type, no
`text/plain` or `text/uri-list` fallback. The composer and manuscript editor
resolve selected row identities through their live `@` tree and copy files and folders as mentions;
other surfaces ignore the drop instead of pasting names that look like a
half-made link. A writing drop stops before the tree's move route, so it never
moves a selected row.

Each list has a `TreeDropScope` whose entries route (`use-entry-list.tsx`,
planning in `move-plan.ts`) answers every hovered target: accept ("Move to Act 2"; "Move to Act 2…"
when the drop will ask, see below), refuse ("Can't go inside
itself", a folder over its own subtree), or nothing (the row is already there, the target is a
navigation-only folder, or the selection holds a row that can't move or has gone). A taken name never refuses: each row arrives at the next free
name (`chapter-2 (2)`), predicted (`arrivals` in `execute-move.ts`) against the destination's
rows plus the rows placed before it in the same drop; the server decides the
final name. The hover shows that prediction before a move: an accept whose rows
would arrive renamed carries a warning, drawn as a second line under the hint
("chapter-1 will be renamed chapter-1 (2)", or "3 items will be renamed"). Letting
go accepts it; Escape or another target declines it. A drop moves every carried row through
`moveRows` (`entry-drag/execute-move.ts`), reselects them and reveals the destination (the target's
own `reveal`, the same one the spring calls). The tree is the whole report of a move that works.
A row no list will take (read-only, not open) toasts "Couldn't move chapter-3 to Act 2."
("Couldn't move 3 items to Act 2." for several) with Retry for the rows it refused. A row the
server refuses later goes back with its failure mark and the server's reason; there is no toast.

Move… and Copy to… report the same way, whether or not a list is mounted. A desktop list
selects the moved row; the phone browser needs no selection or drop scope. Move… does not reveal a
collapsed destination (expansion belongs to each section); moving the open
document reveals it through the active-document reveal.

Placement is optimistic, exactly as for Move…: the record shows at once and a later server
refusal lands on the row as its failure mark. Verdicts likewise resolve each
dragged row by identity from the trees the list shows (rows another list
dragged included), so a peer's rename or move during the drag can't slip a
folder inside itself. A lone moved row stays selected on its own (an explicit
selection of one), not the open row.

### Dropping across systems, and dropping references

In the sidebar the sources sit behind icon tabs, with Scratch (under a named Work), Unfiled and
Trash as rows at its foot
(`shell/sidebar/SourcesBody.tsx`). Each source in its `SOURCES` table has one root drop, used
by its tab or foot row and by its pane (`SourcePane`), and the strip, the foot and the pane
share the sidebar's one drop scope. Dropping on a source's tab lands at that source's root
("Move to Knowledge"), and so does its heading or the space below its last row; the usual
crossing-system rules apply, so Your files still asks. A drag that rests on a tab for 600 ms
opens it, as on a closed folder, for a drop into a folder inside. Scratch's foot row and pane are
the picked Work's Scratch root, a system of its own, so a drop there asks Move or Copy. Trash is a source too,
not a scheme: rows dropped on its row or its pane are deleted at once, with no menu, through
`useDeleteContextEntries`, and its rows drag out to be restored where
they land.

A list row dropped within one system moves at once. A drop that crosses systems (the
project's areas are one system; User and each Scratch owner and each chat's Uploads
are their own, `entrySystem` in `entry.ts`) changes ownership, so the list asks first.
So does every drag that is not a list row (a `reference`, below), even within one
system: a mention chip, main's document title, a path crumb, a Recent row, a receipt or Work
change entry, an Uploads entry, a selected Editor link. The
hover accepts with the first thing the menu would offer and an ellipsis ("Move to
Act 2…", or "Copy to Act 2…" when Move is disabled); the drop opens a compact menu
at the pointer, no heading: "Move to Act 2", "Copy to Act 2", then Cancel. A drop
into Your files (the `user` scheme) from outside offers Copy only: what lives in a
project stays there. A
disabled item says why, tied to it with `aria-describedby` ("Can't move these from
here" for a surface that grants Copy only, "Already there", "Some of these items
are no longer there", "Can't go inside itself"). Escape, Cancel and a click outside
close it with nothing changed, and focus returns to the list. The whole selection
takes one choice; the same-system subset never moves alone. A drop never asks when
nothing it offers is enabled: a folder over its own subtree and a selection that
lost a row refuse on hover instead. Choosing Move goes through `moveRows`, the path
Move… and a same-system drop use.
Choosing Copy goes through `copyRows` (below). Phones have no drag, so no menu: they
use Move… and Copy to…, which already cross systems.

The hover verdict, the decision to ask and the menu all come from `dropChoices`
for a crossing drop (`planMove` alone serves a same-system drop), so a new action
is a new item there and a branch in the list's `choose`. The contract:

- `EntryDrag` (`entry.ts`, held by `drag-session.ts`): `{ entries, source }`. An entry is
  identity (`ref`), the name the preview shows, and the `view` a Copy of it reads (the live
  document, or the draft a title or receipt row shows). `source` is `list-row` or `reference`.
  A drag carries no placement and no grant.
- `ResolvedDrop` (`move-plan.ts`, from `resolveDrop(view, drag, target)`):
  what a drop is now, before any action decides what to do with it. `sources` are
  the outermost placed entries (one inside a carried folder rides with it) with their
  views, `into` (a folder's id, or the source's id), `scheme`, `destinationName` (the tree's current name), `area` (the tree it lands in), `position`,
  `asks` (a reference, or a source in another system than the target), `insideItself`,
  `unavailable` (carried entries no shown tree places), `crossesLists` (an account row into a project, or the reverse) and `canMove`. Copy has no
  condition; Move is refused for a row whose area is not `writable` (an ended Work's Scratch, or
  one the project doesn't list: it fails closed), judged here from each source's placement so a
  new drag source never says it. A drop on such an area lands nowhere. `resolveDrop` returns null
  when the target isn't a place a drop can land. `planMove` and `planCopy` turn it
  into a plan; an action plans from the resolution and never resolves identities
  again.
- `PendingChoice` (`drop-choice.ts`): a drop that asks, waiting for its choice, held
  by the list. It carries the drag, the target, the pointer point and the
  focus-return callback, captured at the drop because
  `dragend` clears the drag session right after it. `EntriesRoute.drop`
  therefore receives the point.
- `DropChoiceItem` (`drop-choice.ts`): `{ action, label, enabled, reason? }`. The
  menu is `dropChoices(resolved, target)`, derived from `resolveDrop`
  against the trees as they are when the menu draws and again when the writer
  picks, so a destination renamed or removed while it was open is judged by
  identity: the label follows a rename, and a removed destination leaves the item
  disabled with its reason. `DropChoiceMenu.tsx` renders the items and knows no
  action.

#### Reference sources

Every non-row source starts its drag through one adapter, `entry-drag/reference-source.ts`: the
source supplies what it names (a document or folder by identity, the name to show, and the view it
shows). An element spreads the props `useReferenceDrag` returns: `draggable` and an `onDragStart`
that publishes the drag with `source: "reference"`. A source that isn't an element (the Editor's
link) takes `useReferenceDragStart()` and calls the start it returns; both give nothing on the
phone shell, and a source that names nothing yet gets no props. A source never reads the replay
or decides what a drop does: `resolveDrop` finds the entry by identity, so a renamed or moved
document drags as itself and a gone one answers "Some of these items are no longer there".

| Source | Names | View |
|---|---|---|
| Main's document title (`MainHeader`) | the document | the draft of the Work under review while the document is under review (`draftCopyView`, owned by draft review); local and draft-only documents don't drag |
| Recent row (`useEntryRow`, not this adapter: it carries the selection) | each selected document by id, never the path it was opened at | live |
| Transcript chip (`TranscriptReference`) | an exact reference the host still resolves; syntax links name no entry | live |
| Composer chip (`ComposerReferenceMenu`) | its document or folder | live |
| Receipt row (`TurnEditsReceipt`), Changes row (`ChangesSource`) | the document the row represents | `draft` for a draft row: the Work the turn wrote in (the receipt's lineage names it) or the Work the row lists (`draftCopyView`); a row the turn deleted, or a change with no draft text, doesn't drag |
| Uploads entry (`ChatFilesMenu`) | the upload's document | live; the section is a drop target that refuses |
| Editor link (`LinkSurfaceExtension`) | the entry a link names, once the link's text is the selection | live |

Nothing a source does after a drag follows or navigates: browsers fire no `click` after a drag.
What a source must still handle is what it carries and what its host does on press.
`startEntryDrag` clears the native drag data (an `<a>` otherwise carries its URL), and the session
is the data: the drag carries only Meridian's own MIME type, empty. In the Editor an unselected
press on a link still sweeps text selection (law 7), so a link drags only once its text is the
selection. ProseMirror starts that drag as it starts any selection's (its `dragstart` runs first),
and `LinkSurface.registerDragSource` is told afterwards (core knows an identity and a label; the app
decides what a drag carries). A drop back into the same editor therefore stays an ordinary text move
(the reference-drop extension defers to the view's own drag); only a drop elsewhere, on a tree
container or the composer, is the entry. A composer chip is a TipTap node view, whose `stopEvent`
already leaves a drag that starts inside it alone.

### Copy

Copy duplicates the carried rows into the destination and leaves the sources where
they are (`planCopy`, `copyRows` in `execute-copy.ts`). Every carried row is
copied, the one already in the destination's parent included (its copy takes the
next free name), and an edge drop may anchor on a carried row. Each entry's `view` goes to the
server with its root: a tree row copies the live document, a draft title or receipt row the draft it
shows. A draft view names its Work and no chat; the server reads that Work's active branch's draft
of the document, and a Work with no draft of it refuses the Copy (it never reads live text). The copies are
one request with one root per row: the browser mints the copies' ids and the command's id and sends
them once (`copyRows`), and the answer places every root or refuses the whole Copy. The copies
arrive through the list like anyone's records.

A refused Copy toasts "Couldn't copy chapter-3 to Vault. A source or the destination is no longer
there." with the route's reason, and Retry sends it again as a new Copy (`entry-failure.ts`).

Targets: a folder row is its folder; a file row hands its drop to its folder (or
the area); an area header is the
tree's top level. A row's top and bottom bands are sibling edges, before or
after that row in its actual parent (`RowEdges` in `tree-drop.tsx`): a third of a
file row, a quarter of a folder row, whose centre keeps moving rows into it. An
open folder has no bottom edge, because its bottom borders its own first child;
"after" it is the next sibling's top edge, drawn below its subtree. Each event
resolves to one target, and an edge claims its event even when it would change
nothing, so the folder region under it never takes over. One element holds one
target at a time; crossing from one edge or the centre to another releases the
first, and its spring, at once. The target key and the route's cached verdict
key (`treeDropTargetKey`) include the edge and its anchor. An accepted edge draws
an `InsertionLine` at the row's indentation instead of the folder fill, and the
hint names the neighbour ("Move before Chapter 3"). `planMove` reads neighbours
from the parent's complete sibling sequence, so a row a search hides still
counts: an edge is quiet when every carried row would end where it is, or when
the anchor is itself carried. Several rows land together in screen order (the
first takes the edge, each next one goes after the one before). Edges don't
spring. Every target names its tree's root, so a list showing
several trees (Scratch and its earlier notes) resolves the right one. The
scope counts hovered elements per target and the innermost target claims each
event; `DropRegion` lights the folder row and everything open under it as one
block. Hovering a
closed folder or area for 600 ms reveals it, and so does an accepted drop on it. The phone shell has no drag.

A scope holds two routes: `entries` (rows dragged inside the app) and `files` (desktop files, imported
into the target's folder; see the [import feature](../../../import/AGENTS.md)). The routes share the
verdict shape, so the hint says what the drop will do ("Import into Lore"). Edges are for rows only: a
file drag skips `targetAt`, so a drop on a row's edge or centre alike imports into that row's folder
and lands at the end of that folder (a batch in name order), never
at the edge's position. Import can't place an arbitrary position for a batch, and an edge that
appeared to accept but landed elsewhere would mislead.

## Trash rows dragged onto the tree

A Trash row starts its drag as source `trash` (`useEntryRow(entry, { active, source: "trash" })`), carrying
the document's id. The entries route recognises it before `resolveDrop`: `planRestore`
(`entry-drag/restore-drop.ts`) judges the same targets (folder, area root, row edge) and a drop calls
`restoreInto` on `DocumentTrashRestoreProvider`, which appends a `restore` record per document and a
`move` to the destination (`TreeActions.restore`, `TreeActions.move`).
A restore never crosses systems (it has no Copy): a project document onto Your files, or the reverse,
refuses with the hint. The rows leave Trash (the Trash list is a server query, edited in place) and appear in the
destination at once from the replay. A restore the server refuses comes back as a settlement on its
record: the entry goes back to Trash with the server's reason; the notice offers Undo, which deletes the restored documents through the normal delete path. Trash's own
list never takes a trash drag (the rows are already deleted).

Trash rows are `ListRow`s with the trees' menu and select like tree rows, through the sidebar's
selection. Right-click and ⋯ share the tree's menu: Restore on one row,
Restore N on a selection. `restore(entries)` on `DocumentTrashRestoreProvider` appends the `restore` records as one update per
list; a refused one shows on its Trash row ("Couldn't restore … " and the reason), and one notice
counts the ones that came back ("Restored 3 files.").
There is no Delete forever: permanent removal is only the scheduled purge.
