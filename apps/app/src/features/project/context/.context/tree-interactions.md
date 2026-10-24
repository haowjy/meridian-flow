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
validation uses the target folder's children. Editor trees list only project schemes (Manuscript, KB, User, Unfiled), and creation there is never Work-scoped: Scratch notes are made only from a Work's Files tab (New note) and by the AI, and Uploads are intake only (`schemeAllowsCreation`). Starting a creation anywhere
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
commit at the area list. The current parent reads "Already in <folder>".
Destination collisions use the inline-name validator before namespace admission;
files keep their name through `setLocation`, folders through `setFolderLocation`.
Catalog snapshots span areas, so menu lookups check source identity as well as
entry identity; equal paths in different areas remain distinct destinations.

Destination resolution, refusals, arrival naming and the replica call live in
`move-entry.ts`, shared with dragging.

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
its drop scope (the Files tree is one list over all four areas, with each
section keeping its own expansion). Rows join through `EntrySelectionProvider`.
Selection keys are `kind:id` and carry no scheme or place, so a moved row keeps
its key and stays selected. A plain click opens or toggles the row as before and leaves no
selection of its own: until the writer Ctrl/Cmd- or Shift-clicks, the selection
is just the open row, shown by the open row's own highlight. Ctrl/Cmd-click
starts an explicit selection from the open row and adds or removes rows;
Shift-click selects the on-screen range from the last clicked row, read from the
DOM (`data-entry-key`) so it always matches what is visible; Escape returns to
the open row. Only explicit selections get the selection fill, a lighter tint of
the open row's fill, so the open row stays findable inside a selection.

Dragging a selected row carries the selection in screen order, minus rows inside
a selected folder; dragging an unselected row carries only it. A row drags only
when its surface grants Move (an archived Work's Scratch doesn't), and a
selection that spans systems or holds an unmovable row moves nowhere rather than
silently dropping rows. `drag-session.ts` holds the drag (a browser hides drag
data until the drop). The transfer carries only Meridian's entries type, no
`text/plain` or `text/uri-list` fallback: a surface that can't take rows yet
(the composer, the editor, until mention drops land) ignores the drop instead of
pasting names that look like a half-made link.

Each list has a `TreeDropScope` whose entries route (`use-entry-list.tsx`,
planning in `move-plan.ts`) answers every hovered target: accept ("Move to Act 2"), refuse ("Can't go inside
itself", a folder over its own subtree), or nothing (the row is already there, the target is a
navigation-only folder, or the drag comes from another system, which Move or
Copy will handle). A taken name never refuses: each row arrives at the next free
name (`chapter-2 (2)`), predicted against the destination's rows plus the rows
placed before it in the same drop, so `execute-move.ts` places rows one at a
time; the server decides the final name. A drop moves every carried row through
`move-entry.ts` (`execute-move.ts`), reselects them, reveals the destination (the target's
own `reveal`, the same one the spring calls) and shows "Moved chapter-3 to Act
2." (or "Moved chapter-3 to Act 2 as chapter-3 (2).") with Undo on the surface
that took the drop (`MoveNotice` in that surface's `MoveNoticeHost`: in the
rail between the Files tree and Scratch, or under Work Files, which stays
visible with the sidebar collapsed). The notice is part of the surface's
layout: it takes height from the tree's scroll area and never covers a
control. It stays until the next move, Dismiss, or the project changing, so
Undo is never a race. A host keeps only its latest result, as data.

Move… inside a list ends the same way: `EntryMovePicker` places through
`move-entry.ts`, then reports to its list (`useReportMove`), which selects the
moved row and publishes the same notice and Undo. Move… does not reveal a
collapsed destination (expansion belongs to each section); moving the open
document reveals it through the active-document reveal. Outside a list (the
phone browser, the chat's Files menu) Move… reports nothing beyond the row.

Placement is optimistic, exactly as for Move…: each placement's operation is
remembered, so the row's link-update note follows its receipt and a later server
refusal lands on the row as its failure mark. A row the replica won't admit is
named in the notice, and Undo still covers the rows that moved. Undo returns
each row to its previous parent under its current name (the next free one if
that name was taken since; the list that took the drop supplies the siblings), skips a row that moved
again since or is gone (the writer's newer choice), and reads the replica as it
is when pressed, not as it was at the drop. Verdicts likewise resolve each
dragged row by identity from the replica's placement graph (rows another list
dragged included), so a peer's rename or move during the drag can't slip a
folder inside itself. A lone moved row stays selected on its own (an explicit
selection of one), not the open row, and Undo needs no reselect because keys
never change.

Targets: a folder row is its folder; a file row hands its drop to its folder (or
the area); an area header, and in Work Files the whole Scratch group, is the
catalog's top level. Every target names its catalog root, so a list showing
several catalogs (Scratch and its earlier notes) resolves the right one. The
scope counts hovered elements per target and the innermost target claims each
event; `DropRegion` lights the folder row and everything open under it as one
block. Hovering a
closed folder or area for 600 ms reveals it, and so does an accepted drop on it. The phone shell has no drag.
