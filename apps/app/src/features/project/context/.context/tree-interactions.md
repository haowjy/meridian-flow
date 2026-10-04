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
`EntryAction` is four actions in fixed order — New file, New folder,
separator, Rename, Delete (creation first, destructive last) — identical in
both triggers. Actions dispatch from `onCloseAutoFocus`, after the menu has
fully closed with its focus return suppressed: menu teardown otherwise blurs
a freshly mounted inline row, and blur commits/cancels it.

## Creation targeting

One required `TreeCreationRequest` serves every entry point:
`{ scheme, kind, parentPath, workId }` (`TreeCreationProvider` request, or the phone
drawer's controlled mirror), with `""` meaning the scheme root. Scheme headers request the root; a folder
row requests itself; a file row requests its parent
(`parentContextEntryPath`). The single `TreeChildren` renderer inserts the
inline CreateRow at the target; the root calls it with an empty child list
before fetch, while nested folders use the same mount at child depth. Creation
explicitly reveals every target ancestor in the stored expansion model before
the request starts. Clicking any scheme or folder disclosure while the row is
open cancels creation and then performs the requested toggle; disclosure clicks
must never feel inert. Sibling-collision
validation uses the target folder's children. The captured `workId` keeps an in-flight request on its initiating Editor scope across route changes. Starting a creation anywhere
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
routes. A refused rename returns the entry to its old name with
`NamespaceFailureMark` on the row and the repair name in the reopened field.
A document under a pending move (its own or a folder above it) carries
`placementPending`: until the server confirms, a server alias for the path the
writer just gave it cannot pull the route back to the old name. The phone shell,
which derives its document from the route, finds a bound document by identity
while the URL still names the old path; the server's redirect repairs the URL
once the move settles. Inline operations keep stable entry identity. Work
selection is attached only to Scratch/Uploads, never project-owned
Manuscript/KB/User paths.
