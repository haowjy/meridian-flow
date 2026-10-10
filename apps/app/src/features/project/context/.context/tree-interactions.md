# Tree interactions

Reference detail for Context-tree interactions. Read [CONTEXT.md](CONTEXT.md)
for feature-level contracts first.

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
| validate siblings | all siblings | siblings excluding current |
| select | — | extension-aware selection |

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
or deletion. Folder deletion still sends the direct context command and admits
its exact result to the availability coordinator. Tree absence never proves
document removal.

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
return the operation id issued at admission; `LinkUpdateNote` reads that receipt
through `settledNamespaceReceipt` and shows "Updated N links" on its own line under
the name in the tree, drawer and Work Files rows, inline in the phone listing, or
after the open document's identity path. The operation registry is keyed by document,
so a file renamed or moved from any list shows the note in both places. It mounts and
watches nothing until a rename returns an operation id, lives until the receipt's
own deadline (settlement plus four seconds, however often its row remounts), ends
its watch there, and announces once per operation through the app's polite region.
Picker moves with zero updated links show "Moved to <folder>" after successful
settlement, with the same lifetime and announcement. Refused moves show nothing.
Refused row moves retain the journal destination in the catalog projection. Comparing that destination with the projected parent and owner distinguishes them from name-only refusals: the failure mark stays on the row, and reopening Move shows the failed destination with retry guidance, never an automatic rename field. Retry validation and submission use the retained
destination name, including a cancelled rename/move chain; fresh moves use the
entry's current name. Work Files uses the same picker and repair decision.
The remembered operation follows the entry's identity across row remounts. Inline
operations keep stable entry identity. Work selection is attached only to
Scratch/Uploads, never project-owned Manuscript/KB/User paths.


## Move picker and Scratch rows

Move… follows Rename in the shared action specification, including phone actions.
`EntryMovePicker` mounts `useProjectMenuSource` and `DrillInMenu` only while open; closed rows keep only their stable row anchor. It starts inside
the current parent, disables files and the moved folder's subtree, and offers no
commit at the area list. The current parent reads "Already in <folder>".
Destination collisions use the inline-name validator before namespace admission;
files keep their name through `setLocation`, folders through `setFolderLocation`.
Catalog snapshots span areas, so menu lookups check source identity as well as
entry identity; equal paths in different areas remain distinct destinations.

The chat's Scratch renders actual entries through `ContextTreeEntry` and its
`TreeEnvProvider`, retaining lineage or Work authority. Rename and Move… share the Files implementations; create and Delete actions are absent. The actual owning Work determines editability (`isWorkArchived`); archived or unavailable Work owners remain navigable with no mutation controls. Shared rows receive explicit action capabilities from their surface. The synthetic
"Earlier notes" group is navigation only, not a mutable folder.
