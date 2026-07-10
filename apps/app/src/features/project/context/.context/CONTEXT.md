# features/project/context — contracts, architecture, and patterns

Reference depth for the context file tree module. Read the [AGENTS.md](../AGENTS.md)
first for intent and mental model.

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
```

The tree query (`useContextTree`) fetches from
`/api/projects/:projectId/context/:scheme/tree`. Mutations post to
`create.post.ts`, `rename.post.ts`, `delete.post.ts`, and `upload.post.ts`,
then invalidate the tree cache on success.

Desktop (ContextTreePanel) renders the full tree as a recursive component
(`TreeBlock` → `DirRow` / `FileRow`). Mobile (MobileContextBrowser) renders
one level at a time, driven by route params (`?scheme=`, `?folder=`, `?path=`).

## Contracts

### InlineNameForm contract

`useInlineNameForm` is the shared state machine. See `use-inline-name-form.ts`
for the full type signatures (`UseInlineNameFormOptions` / `InlineNameForm`).

**Submit semantics:**
- Enter commits (unless pending or blocked by error-level validation).
- Escape cancels (sets `cancelledRef`, then calls `onDone`).
- Blur-with-content commits (unless Escape already cancelled).
- Empty or cancel-name input = cancel (calls `onDone` without mutation).
- Blocking errors (`severity.level === "error"`) keep the row open and refocus.

**Focus behavior:**
- Auto-focus on mount via `useEffect`.
- `requestAnimationFrame` retry handles Radix menu focus-scope teardown: the
  menu's closing animation holds focus for one frame, swallowing a same-tick
  `focus()`. The rAF retry is harmless when no menu preceded the row.

### EntryAction contract

Both the right-click context menu and the hover-revealed kebab dispatch the
same `EntryAction` type (`"rename" | "delete"`) through a shared
`EntryActionTarget` (`{ name, path, kind }`). See `ContextEntryActions.tsx`.

`ActionMenuItems` renders the menu items and is shared between
`ContextMenuPrimitive.Content` and `DropdownMenuContent`. Add an action once;
both triggers pick it up.

### Delete confirmation

`useDeleteConfirmation` manages the dialog state machine. See
`ContextEntryActions.tsx` for the hook and `DeleteConfirmationDialog`
presentational shell (canonical `Button` primitives, title branches on
`target.kind`).

### Tree query invalidation

All mutations invalidate `useContextTree` on success. The invalidation is
scheme-scoped: deleting a file in `manuscript://` only refetches that tree.
The last-opened file store (`context-files-store`) is also cleared on delete
to prevent a dead tab reference.

## Patterns

### Dual trigger: ContextMenu + DropdownMenu

Desktop file/folder rows provide two paths to the same actions:

- **Right-click** → `ContextEntryMenu` (Radix `ContextMenu` wrapping the row).
- **Hover** → `EntryKebabButton` (Radix `DropdownMenu` with `IconButton`
  trigger, revealed on `group-hover:opacity-100`).

Both render `ActionMenuItems`. This is **not** a shared menu component (Radix
`ContextMenu.Item` and `DropdownMenu.Item` are different primitives), but the
labels, icons, and action dispatch are shared.

The kebab stops event propagation so opening the dropdown does not trigger the
row's click handler (which opens files or toggles folders).

### Trailing slot over boolean flag

Mobile `DrillRow` separates the full-width tap target from a trailing action
slot via `trailing: ReactNode`. The trailing slot renders on the right edge — a
chevron for drill-in scheme rows, or a `...` action button for file/folder rows.
Clicking the trailing slot does not trigger the row's `onClick` because the
button has its own handler and stops propagation.

### Thin adapter over shared core

`useInlineNameForm` owns the complete name-entry state machine. Adapters supply
only what differs:

| Concern | `useCreateEntryForm` | `useRenameEntryForm` |
|---|---|---|
| initialName | `""` | `entry.name` |
| isCancelName | — | same as current name |
| siblingNames | all siblings | siblings excluding current |
| afterFocus | — | extension-aware selection |

Both adapters are ~25 lines. The shared core is ~100 lines. Adding a third
inline name form is a new adapter, not a fork.

## Downlinks

- [Server context domain](../../../../../../../apps/server/server/domains/context/AGENTS.md) — ContextPort, URI schemes, route helpers
- [Desktop project shell](../.context/CONTEXT.md) — slot topology, surface-prefs store
- [Mobile project shell](../mobile/.context/CONTEXT.md) — phone shell, drill-in navigation
