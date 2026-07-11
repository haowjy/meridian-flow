# features/project/context — contracts and architecture

Reference depth. Read the [AGENTS.md](../AGENTS.md) first.

## Architecture

```text
ContextTreePanel (desktop)          MobileContextBrowser (mobile)
       │                                     │
       ├─ useContextTree (React Query) ──────┤
       ├─ useCreateEntryForm ────────────────┤
       ├─ useRenameEntryForm ────────────────┤
       ├─ useDeleteConfirmation ─────────────┤
       └─ ContextEntryActions (menus) ───────┘
                     │
              useInlineNameForm (shared core)
                     │
          validateContextEntryName (pure)

ContextPaneController
       ├─ route ↔ server-tab reconciliation
       ├─ persisted TempDocument[] → ContextTab { kind: "temp" }
       └─ ContextViewer
              ├─ ContextTabBar (tracked, viewer, and temp tabs)
              ├─ ContextEditorMountHost (warm tracked editors)
              ├─ ContextViewerHost (active binary viewer)
              └─ TempDocumentEditor (active device-local draft)
```

`useContextTree` fetches `/api/projects/:projectId/context/:scheme/tree`.
Mutations (`create`, `rename`, `delete`, `upload`) invalidate the tree cache on
success. Invalidation is scheme-scoped.

`useFileSuggestions` composes those same cached per-scheme queries and ranks a
flattened client-side view. It never adds a server-search path; hosts constrain
schemes and file/directory kinds, then mount the presentation-only list.

Desktop renders recursively (`TreeBlock` → `DirRow` / `FileRow`). Mobile renders
one level at a time via route params.

## Editor tabs and temporary documents

The writer-facing destination is **Editor** (the source directory and context
URI domain retain `context` as their implementation name). `ContextPaneController`
owns route reconciliation, tab selection and close behavior, last-route restore,
work-scoped tab pruning, and per-tab scroll restoration. `ContextViewer` only
chooses the active rendering host; `ContextTabBar` only renders and delegates
tab interactions.

`ContextTab` is the presentation union: `tracked`, `viewer`, or `temp`. Server
tabs remain the ephemeral open-file working set in `context-tabs-store`; device-
local temporary document content is persisted by `temp-docs-store` and projected
into the same union by the controller. Do not add a second parallel tab model.
Temporary documents have no context URI and do not participate in route matching.

`TempDocumentEditor` is a standalone TipTap editor. Saving captures an immutable
content/destination/name/revision snapshot, creates the durable context file,
then navigates to that file. The temp document is removed only when its current
revision still equals the saved snapshot. A path conflict offers the existing
file or a rename; a later local revision stays open after the snapshot saves, so
newer words cannot be discarded. Closing a non-empty temp document requires an
explicit discard confirmation.

Tree creation state belongs to `TreeCreationProvider`, shared by the sidebar
tree and Editor empty state; it is not controller-local state.

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

Desktop context menu and kebab both render `ActionMenuItems`, but Radix
`ContextMenu.Item` and `DropdownMenu.Item` are different primitives — the
component is not literally shared, only the labels, icons, and dispatch logic.
The kebab stops propagation so it doesn't trigger the row's click handler.

## Tree query invalidation

Deleting a file in `manuscript://` only refetches that scheme's tree. The
last-opened route (`context-last-route`) is also cleared on delete to prevent a
dead tab reference.

## Downlinks

- [Server context domain](../../../../../../../apps/server/server/domains/context/AGENTS.md)
- [Desktop project shell](../../.context/CONTEXT.md)
- [Mobile project shell](../../mobile/.context/CONTEXT.md)
