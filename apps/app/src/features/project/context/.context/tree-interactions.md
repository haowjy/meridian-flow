# Tree interactions

Reference detail for Context-tree interactions. Read [CONTEXT.md](CONTEXT.md)
for feature-level contracts first.

## Shared nested rows

Work Files, the context sidebar, and the phone browser render ordinary nested
folders through `TreeChildren`. Search supplies visible ids
with ancestor closure, not a filtered catalog: rename and move collision checks
always see all siblings. Search disclosure is temporary; it never overwrites
the normal expansion state. A newly created Work note stays visible for naming
even when its name does not match the search.

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
| validate siblings | all sibling identities and kinds | siblings excluding current identity |
| select | — | the part before a visible extension; all of a prose name |

Names are compared and submitted as the contracts codec stores them
(`storedFilename`, `entryNameKey` in `context-entry-name.ts`): a prose name
has no extension, so `Chapter 13.md` typed on `Chapter 13` is no change and
beside `Chapter 13` collides; a bare name keeps the renamed file's visible
extension (`settings` on `config.toml`). Folder-to-folder comparison is literal;
the codec comparison applies when either entry is a document. Conflict copy names
the occupant's kind, not the requested kind. The codec's `invalid_name` message
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
the current parent for a new move. A retry opens at the refused destination
when it still resolves (matching owner and full path), otherwise at the
current parent with the refusal message. It disables files and the moved folder's subtree, and offers no
commit at the area list. The current parent reads "Already in <folder>".
Destination collisions use the inline-name validator before namespace admission;
files keep their name through `setLocation`, folders through `setFolderLocation`.
Catalog snapshots span areas, so menu lookups check source identity as well as
entry identity; equal paths in different areas remain distinct destinations.

The chat's Scratch renders one owner-bound `TreeEnvProvider` and `TreeChildren`
per real catalog. Earlier notes is a navigation disclosure outside the second
lineage tree, not a menu-node projection or a mutable catalog folder. Selected
files open directly with their known owner. Rename, Move… and Delete share the Files implementations through
`useEntryInteraction`, the row boundary for management state, dispatch and
operation selection. Creation is absent. One surface-owned deletion coordinator
and dialog serve all Scratch rows, retaining each target's owner. The actual owning Work determines editability (`isWorkArchived`); archived or unavailable Work owners remain navigable with no mutation controls. Shared rows receive explicit action capabilities from their surface. The synthetic
"Earlier notes" group is navigation only, not a mutable folder.
