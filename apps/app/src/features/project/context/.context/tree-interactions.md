# Tree interactions

Reference detail for Context-tree interactions. Read [CONTEXT.md](CONTEXT.md)
for feature-level contracts first.

## InlineNameForm semantics

The shared state machine in `use-inline-name-form.ts`. Adapters supply options;
the core owns focus, validation, and commit behavior.

**Submit:** Enter commits (unless pending or error-blocked). Escape cancels.
Blur-with-content commits (unless Escape already cancelled). Empty input =
cancel. Blocking errors refocus the input.

**Focus:** Auto-focus on mount. `requestAnimationFrame` retry handles Radix menu
focus-scope teardown — the menu's closing animation holds focus for one frame,
swallowing a same-tick `focus()`.

**Adapter differences:**

| Concern | `useCreateEntryForm` | `useRenameEntryForm` |
|---|---|---|
| initialName | `""` | `entry.name` |
| isCancelName | — | same as current name |
| siblingNames | all siblings | siblings excluding current |
| afterFocus | — | extension-aware selection |

Both adapters are ~25 lines. The shared core is ~100 lines.

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
`useInlineNameForm` contract.

## Tree query invalidation

Deleting an editable file queues a resource deletion intent and hides the row
optimistically. A terminal receipt carries exact identity and generation into
session/removal authority. A transport or conflict failure restores the row with
a retry marker. Folder deletion still sends the direct context command and admits
its exact result to the availability coordinator. Tree absence never proves
document removal.

## Downlinks

- [Server context domain](../../../../../../../apps/server/server/domains/context/AGENTS.md)
- [Desktop project shell](../../.context/CONTEXT.md)
- [Mobile project shell](../../mobile/.context/CONTEXT.md)

File rename and the identity bar share the durable resource-location command.
Folder rename alone retains `context-identity-mutation.ts`. Inline operations
keep stable entry identity. Work selection is attached only to Scratch/Uploads,
never project-owned Manuscript/KB/User paths.
