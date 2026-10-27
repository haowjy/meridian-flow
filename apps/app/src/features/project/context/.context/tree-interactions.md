# Tree interactions

Reference detail for Context-tree interactions. Read [CONTEXT.md](CONTEXT.md)
for feature-level contracts first.

## Shared nested rows

Work Files, the context sidebar, and the phone browser render ordinary nested
folders through `TreeChildren`. Search supplies visible ids
with ancestor closure, not a filtered catalog: rename and move free-name predictions
always see all siblings. Search disclosure is temporary; it never overwrites
the normal expansion state. A newly created Work note stays visible for naming
even when its name does not match the search.

Indentation counts visible expandable parents, not catalog depth: standalone
Work Files and phone lists start at zero; rail sections start at one. The shared
`TreeGroup` spans all visible children, including Earlier notes and the current
Work’s separate catalog. It paints its parent guide above row highlights without taking pointer
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
| validate siblings | all sibling identities and kinds | syntax only; sibling claims choose the optimistic free name |
| select | — | the part before a visible extension; all of a prose name |

Names are compared and submitted as the contracts codec stores them
(`storedFilename`, `entryNameKey` in `context-entry-name.ts`): a prose name
has no extension, so `Chapter 13.md` typed on `Chapter 13` is no change and
beside `Chapter 13` predicts `Chapter 13 (2)`; a bare name keeps the renamed file's visible
extension (`settings` on `config.toml`). Folder-to-folder comparison is literal;
the codec comparison applies when either entry is a document. Create conflict copy names the occupant's kind, not the requested kind. Rename and move never block on a sibling claim: the shared allocator predicts the landed name immediately, and the server receipt replaces it after settlement. The codec's `invalid_name` message
shows on the field. Rename and identity commits transport the writer's typed name.
`planResourceLocation` stores it as `typedName` beside the canonical optimistic
destination; the request sends `typedName`, and the server mover computes the stored
name once. A canonical name is never fed back into extension inheritance.


## Dual-trigger caveat

Desktop right-click context and visible ellipsis overflow map one ordered action
specification through thin renderers for Radix `ContextMenu.Item` and
`DropdownMenu.Item`. They remain separate trigger primitives. The visible path
uses the neutral `OverflowMenu` and canonical trigger shared with Project chat
rows and Composer; context-specific `EntryAction` types do not cross that UI
boundary. The raw ContextMenu renderer consumes the canonical declarations from
`components/ui/dropdown-presentation.ts` directly for surface, row, separator,
destructive, density, focus, and animation paint. Do not copy those recipes or
introduce a shallow ContextMenu wrapper family merely to adapt Radix. The
visible target is 32 px for fine pointers and 44 px for coarse/no-hover input,
and it remains visible while its portaled menu is open. Mobile uses the same
context adapter with a 44 px target. Labels, icons, grouping, destructive
metadata, order, presentation, and dispatch actions therefore cannot drift.
The ellipsis stops propagation so it doesn't trigger the row's click handler.
`EntryAction` is five actions in fixed order — New file, New folder,
separator, Rename, Move…, Delete (creation first, destructive last) —
identical in both triggers. Each list declares which of them it supports. Actions dispatch from `onCloseAutoFocus`, after the menu has
fully closed with its focus return suppressed: menu teardown otherwise blurs
a freshly mounted inline row, and blur commits/cancels it.

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

## Tree query invalidation

Deleting an editable file queues a resource deletion intent and hides the row
optimistically. A terminal receipt carries exact identity and generation into
session/removal authority. A rejected deletion restores the row with repair state. Transport
failure leaves the submitted attempt recoverable and does not prove rejection
or deletion. Folder deletion uses the same account namespace journal: its receipt
settles the folder and exact descendant identities atomically. Pending deletion
hides the subtree; refusal restores rows with a failure mark. Tree absence never
proves document removal.

Writer deletion has no confirmation step. One project-scoped owner keeps the short-lived
Undo windows for all mounted tree surfaces, while delete progress remains derived from the
namespace journal. Undo waits for a pending intent, reads the delete receipt, and restores the
receipt's named removals. The catalog stream makes restored identities visible again. A local
file restoration then replays the deletion-time sibling witnesses through `moveRows`, so a manual
parent regains the file's former position and remains manual; it is skipped when the writer admitted
a newer placement of the restored file meanwhile (`placementTakenSince`). A document the server never
accepted gets an Undo window too, ten minutes (`LOCAL_DELETION_UNDO_MS`): the deletion settles on this device
and its exact content waits out the window (`cleanup.notBefore`). Undo supersedes that deletion and sends the
document's create again; a document whose create the server refused is refused again, once, and stays listed
in Unfiled with its text. An empty folder deletion has no Undo window.

## Downlinks

- [Server context domain](../../../../../../../apps/server/server/domains/context/AGENTS.md)
- [Desktop project shell](../../.context/CONTEXT.md)
- [Mobile project shell](../../mobile/.context/CONTEXT.md)

Every rename is local first. File rename (any area, any Work) and the identity bar
share the durable resource-location command; folder rename admits a folder
namespace intent through `AccountResourceReplica.setFolderLocation`. The folder
and its descendants show their new place at once in the tree, open tabs and
routes, and so does the phone. One placement source, the projected catalog, serves
every surface, and a route resolves its open document by identity: the document the
route holds by continuity (`routeContinuityDocumentId`: bound in the removal
coordinator's Editor-context locator, whatever Work the Editor selects, and actually
admitted by this surface; a binding a cached tab guessed before the server answered
is not continuity) is found by id, so a
move of it or a folder above it, that move's rollback after a refusal, or another
document taking the path it holds or left never strands it. `resolveLocalDocumentAddress`
returns it as `bound` and it outranks the server's answer for that path; admission
then repairs the URL (and, on the phone, the crumbs) to its projected path, and the
phone host finds the same document by identity meanwhile. A document under a pending
move carries `placementPending` for the same reason: a server alias for the path the
writer just gave it cannot pull the route back.

A refused rename returns the entry to its old name with `NamespaceFailureMark` on
the row. The identity bar of a homed document shows a passive status directing
retry to Rename in the file list; only provisional placement opens a field there.
The list repair field opens once, as the refusal arrives (`use-repair-on-fresh-failure.ts`): a
failure already there on mount, a remount, or one that lands while another input is
active leaves only the mark; blur dismisses the field without retrying and Enter
retries.

A document whose create the server refused sits in Unfiled with its text and the same mark
(`namespaceFailure: "create"`, "Couldn't create this document. Try another place."). Its row menu
repairs it like any row: Move… or Rename files it with a new create under the same id,
Delete removes it from this device with the Undo window above. A refused named create (New file in a folder, a link's
Create) is listed at its name, not under a folder of the refused destination.

The move's receipt carries `linkUpdate.links`. `setLocation` and `setFolderLocation`
return the operation id issued at admission; the account-owned lifecycle watches
its journal receipt and `LinkUpdateNote` shows "Updated N links" on its own line
under the name in tree, drawer and Work Files rows, inline in the phone listing,
or after the open document's identity path. Selection is keyed by stable resource
handle (folder handles for folders). Presentation document IDs resolve through
the replica's canonical identity/alias policy, so feedback follows remint and
appears in every mounted surface. Observation starts at admission and ends on
positive terminal evidence or the receipt's deadline (settlement plus four
seconds), independently of row mounts. Missing cached records are not terminal
evidence. Each operation announces once through the app's polite region.
A move that updated no links shows nothing: the writer just did it and can see
where the row went (owner, 2026-10-14). Refused moves show nothing.
Refused row moves retain the journal destination in the catalog projection. Comparing that destination with the projected parent and owner distinguishes them from name-only refusals: the failure mark stays on the row, and reopening Move shows the failed destination with retry guidance, never an automatic rename field. Retry validation and submission use the retained
destination name, including a cancelled rename/move chain; fresh moves use the
entry's current name. Work Files uses the same picker and repair decision.
The remembered operation follows the entry's identity across row remounts. Inline
operations keep stable entry identity. Work selection is attached only to
Scratch/Uploads, never project-owned Manuscript/KB/User paths.


## Move picker and Scratch rows

Move… follows Rename in the shared action specification, including phone actions.
`EntryMovePicker` mounts `useProjectMenuSource` and `DrillInMenu` only while open; closed rows keep only their stable row anchor. It starts inside
the current parent for a new move. A retry opens at the refused destination
when it still resolves (matching owner and full path), otherwise at the
current parent with the refusal message. It disables files and the moved folder's subtree, and offers no
commit at the area list. In the current parent the action is "Change position in <folder>", which
opens the places among its siblings in place of the tree (`DrillAction.choices`): the top, after each
sibling, the bottom, read from the replica's complete sibling order (`childrenAt`, not what a search
shows), without the place it already holds. It reads "Already in <folder>" only when the entry has no
siblings. The phone uses the same picker; it has no drag.
A taken name never refuses: the row arrives at the next free name (predicted
from the destination's rows, decided by the server) through `setLocation` for
files and `setFolderLocation` for folders. Before the click, the destination's
Move action carries a warning line under it ("chapter-1 will be renamed
chapter-1 (2)", the `note` of a `DrillAction`).
Catalog snapshots span areas, so menu lookups check source identity as well as
entry identity; equal paths in different areas remain distinct destinations.

Move… and dragging share every step. Refusal is judged by identity from the
replica's placement graph (`moveRefusal` in `entry-drag/move-plan.ts`), so the
picker and a hover agree even while a peer moves rows. A ready drag plan already
contains rows with their authoritative `ParentRef`; hover prediction and
`moveRows` consume those rows without resolving the destination again.
`moveRows` (`entry-drag/execute-move.ts`) places, remembers each operation for
its row's link-update note and returns the result to the project-owned notice
surface. Root authority resolution lives in `move-entry.ts`; arrival naming is
`arrivals` in `execute-move.ts`, over `context-entry-name.ts`. A positional
destination makes a same-parent placement a reorder rather than "already there";
the subject is removed from name occupancy, so keeping its name cannot collide
with itself. Cross-parent placement without a position appends when the server
says the destination parent is manual.

The chat's Scratch renders one owner-bound `TreeEnvProvider` and `TreeChildren`
per real catalog. Earlier notes is a navigation disclosure outside the second
lineage tree, not a menu-node projection or a mutable catalog folder. Selected
files open directly with their known owner. Rename, Move… and Delete share the Files implementations through
`useEntryInteraction`, the row boundary for management state, dispatch and
operation selection. Creation is absent. One surface-owned deletion coordinator
and dialog serve all Scratch rows, retaining each target's owner. The actual owning Work determines editability (`isWorkArchived`); archived or unavailable Work owners remain navigable with no mutation controls. Shared rows receive explicit action capabilities from their surface. The synthetic
"Earlier notes" group is navigation only, not a mutable folder.

## Selecting and dragging rows

The Files tree, the chat's Scratch and a Work's Files are each one list:
`useEntryList` owns its selection, its entries route and, through `EntryList`,
its drop scope (the Files tree is one list over the project's three areas,
with each section keeping its own expansion). User is its own list and system,
docked above Scratch (`UserRailSection` over the shared `DockedRailSection`),
so a drag between it and the tree stays quiet. Rows join through `EntrySelectionProvider`.
Selection keys are `kind:id` and carry no scheme or place, so a moved row keeps
its key and stays selected. A plain click opens or toggles the row as before and leaves no
selection of its own: until the writer Ctrl/Cmd- or Shift-clicks, the selection
is just the open row, shown by the open row's own highlight. Ctrl/Cmd-click
starts an explicit selection from the open row and adds or removes rows;
Shift-click selects the on-screen range from the last clicked row, read from the
DOM (`data-entry-key`) so it always matches what is visible; Escape returns to
the open row. Only explicit selections get the selection fill
(`sidebar-selected`, the row fill with a little jade), which reads apart from
hover and from the open row's fill, so the open row stays findable inside a
selection. Adjacent selected rows join into one block rounded only at its ends:
after each commit the selection marks each row's place in its run
(`data-selection-run`) in one pass over screen order. The same
modifiers with Enter or Space select from the keyboard, and a selected row
reports `aria-pressed` (rows are buttons, not tree items, so that is the state
they can carry).

Dragging a selected row carries the selection in screen order, minus rows inside
a selected folder; dragging an unselected row carries only it. A row drags only
when its surface grants Move (an archived Work's Scratch doesn't), and a
selection that holds an unmovable row, or one that lost a row (a peer deleted it,
or its parent isn't known yet), moves nowhere rather than silently dropping rows. `drag-session.ts` holds the drag (a browser hides drag
data until the drop). The transfer carries only Meridian's entries type, no
`text/plain` or `text/uri-list` fallback. The composer and manuscript editor
resolve selected row identities through their live `@` catalog and copy files and folders as mentions;
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
final name. The hover shows that prediction before the drop: an accept whose
rows would arrive renamed carries a warning, drawn as a second line under the
hint ("chapter-1 will be renamed chapter-1 (2)", or "3 items will be renamed").
Letting go accepts it; Escape or another target declines it. A drop moves every carried row through
`moveRows` (`entry-drag/execute-move.ts`), reselects them, reveals the destination (the target's
own `reveal`, the same one the spring calls) and shows "Moved chapter-3 to Act
2." (or "Moved chapter-3 to Act 2 as chapter-3 (2).") with Undo on the surface
that took the drop, in that surface's one notice place, shared with delete
notices (see `CONTEXT.md`): in the rail (and the phone drawer) between the
Files tree and User, under Work Files (visible with the sidebar collapsed), at
the end of the chat Files menu, and at the end of the phone folder browser. The
notice is part of the surface's layout: it takes height from the tree's scroll
area and never covers a control. It stays until the next move or delete on
that surface, Dismiss, or the project changing, so Undo is never a race.
`MoveNoticesProvider` keeps each surface's latest move, as data, whether or
not the list that made it is still on screen. Undo shows only while it has
something to put back: the provider watches the replica and retires Undo once
every moved row was renamed, moved again, reordered or deleted (only after the move has
shown in the replica, which can trail the placement by a moment); the message
stays until dismissed. A row the server refuses goes back with its failure mark,
and the notice stops saying it moved: "Couldn't move chapter-3." without Undo,
or "Moved 2 items to Act 2. Couldn't move chapter-3." when the rest landed.
Refused means the replica settled that move's own operation (`MoveEffect.operationId`)
as needs-repair (`moveSettlement`); a row the writer changed since supersedes that
intent, so it only loses Undo. A refusal names its row as it was (`entryNameNow`), so the
notice drops that line once the row is renamed or gone, and the notice itself once nothing is left to say.
Freshness uses the move receipt's per-entry `locationVersion` after its server observation fence,
not the catalog's scope-wide observation version; unrelated namespace edits therefore do not retire
Undo, while a same-entry peer change does even if it later returns to the same rank.

Each surface's window is in one phase, and the phase decides what shows:

| Phase | Shows | Watches |
|---|---|---|
| `moved` | "Moved …", Undo while `undoable` | forward moves the server hasn't settled (`unsettled`) |
| `undoing` | the same notice, Undo disabled | nothing; the replica is admitting the reverse moves |
| `reversing` | nothing | reverse moves the server hasn't settled |
| `undo-failed` | "Couldn't move chapter-3 back.", Dismiss only | the rest of the reverse moves, which can only add to the count |

Undo goes to `reversing` when the replica took every row back, or to `undo-failed`
when it refused some (or threw). A server refusal in `reversing` brings the notice
back as `undo-failed`. `reversing` ends once every reverse move is accepted or
superseded by the writer's next change; a newer notice on the surface or the project
changing ends any phase. Only a settled state retires a tracked operation:
the replica admits a move before its projection shows the intent, so an intent
`moveSettlement` can't find yet counts as pending. Journals keep their intents, so
"not found" is never a pruned intent. A row whose record left the projection stays
pending; its window ends with the next notice or the project.

Move… publishes through the required surface supplied around its rows, whether
or not a list is mounted. A desktop list optionally selects the moved row and
restores focus after its notice closes; the phone browser needs neither list
behavior nor a drop scope. Move… does not reveal a
collapsed destination (expansion belongs to each section); moving the open
document reveals it through the active-document reveal.

Placement is optimistic, exactly as for Move…: each placement's operation is
remembered, so the row's link-update note follows its receipt and a later server
refusal lands on the row as its failure mark. A row the replica won't admit is
named in the notice, and Undo still covers the rows that moved. Undo returns
each row to its previous parent and sibling position (the next free name there if its own was taken
since, read from the replica's placement with `childrenAt`). The reverse placement
leaves that parent manually ordered. Undo is a compensating placement batch: it
skips a row whose placement another operation owns now (`placementStillOwned`:
a newer live placement of that row in the journal, or after the receipt is
covered by the catalog, a different `locationVersion`), never because a sibling
gap looks different, so rows moved together can all be undone before any is
acknowledged. The compensation is admitted after the originals and projects at
once. It reads the replica as it
is when pressed, not as it was at the drop. Verdicts likewise resolve each
dragged row by identity from the replica's placement graph (rows another list
dragged included), so a peer's rename or move during the drag can't slip a
folder inside itself. A lone moved row stays selected on its own (an explicit
selection of one), not the open row, and Undo needs no reselect because keys
never change.

### Dropping across systems

A drop within one system moves at once. A drop that crosses systems (the
project's areas are one system; User and each Scratch or Uploads owner are their
own, `entrySystem` in `entry.ts`) changes ownership, so the list asks first. The
hover accepts with an ellipsis ("Move to Act 2…"); the drop opens a compact menu
at the pointer, no heading, its items named for the destination ("Move to Act
2"), then Cancel. Escape, Cancel and a click outside close it with nothing
changed, and focus returns to the list. The whole selection takes one choice;
the same-system subset never moves alone. Choosing Move goes through `moveRows`,
the path Move… and a same-system drop use, and reports with the same notice and
Undo. Phones have no drag, so no menu: they use Move…, which already crosses
systems.

Three exported types are the contract a later action (Copy) plugs into without
touching the menu's mechanics:

- `ResolvedDrop` (`move-plan.ts`, from `resolveDrop(view, entries, target)`):
  what a drop is now, before any action decides what to do with it. `sources` are
  the outermost placed rows (a row inside a carried folder rides with it),
  `into`, `destinationName` (the catalog's current name), `position`,
  `crossing`, `insideItself`, `unavailable` (carried rows the replica can't place)
  and `movable`. `resolveDrop` returns null when the target isn't a place a drop
  can land. `planMove(view, resolved)` turns it into a Move plan; an action plans
  from the resolution and never resolves identities again.
- `PendingChoice` (`drop-choice.ts`): a crossing drop waiting for its choice, held
  by the list. It carries the dragged entries, the target, the pointer point, the
  notice surface and the focus-return callback, captured at the drop because
  `dragend` clears `activeEntryDrag()` right after it. `EntriesRoute.drop`
  therefore receives the point.
- `DropChoiceItem` (`drop-choice.ts`): `{ action, label, enabled, reason? }`. The
  menu is `dropChoices(view, pending)`, derived from `resolveDrop` against the
  replica as it is when the menu draws and again when the writer picks, so a
  destination renamed or removed while it was open is judged by identity: the
  label follows a rename, and a removed destination leaves the item disabled
  with its reason. `DropChoiceMenu.tsx` renders the items and knows no action.
  Copy joins by adding a `DropAction` and its plan to `dropChoices`.

Targets: a folder row is its folder; a file row hands its drop to its folder (or
the area); an area header, and in Work Files the whole Scratch group, is the
catalog's top level. A row's top and bottom bands are sibling edges, before or
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
spring. Every target names its catalog root, so a list showing
several catalogs (Scratch and its earlier notes) resolves the right one. The
scope counts hovered elements per target and the innermost target claims each
event; `DropRegion` lights the folder row and everything open under it as one
block. Hovering a
closed folder or area for 600 ms reveals it, and so does an accepted drop on it. The phone shell has no drag.

A scope holds two routes: `entries` (rows dragged inside the app) and `files` (desktop files, imported
into the target's folder; see the [import feature](../../../import/AGENTS.md)). The routes share the
verdict shape, so the hint says what the drop will do ("Import into Lore"). Edges are for rows only: a
file drag skips `targetAt`, so a drop on a row's edge or centre alike imports into that row's folder
and lands by the folder's order rule (name order in a default parent, the end of a manual one), never
at the edge's position. Import can't place an arbitrary position for a batch, and an edge that
appeared to accept but landed elsewhere would mislead.
