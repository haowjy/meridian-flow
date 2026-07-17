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
       ├─ in-memory ContextTab[] (tracked, viewer, and new)
       └─ ContextViewer
              ├─ ContextTabBar
              ├─ ContextEditorMountHost (warm tracked + untitled Yjs editors)
              ├─ ContextViewerHost (active binary viewer)
              └─ EditorBannerSlot (draft chrome or untitled rename line)
```

`useContextTree` fetches `/api/projects/:projectId/context/:scheme/tree`.
Mutations (`create`, `rename`, `delete`, `upload`) invalidate the tree cache on
success. Invalidation is scheme-scoped.

`useFileSuggestions` composes those same cached per-scheme queries and ranks a
flattened client-side view. It never adds a server-search path; hosts constrain
schemes and file/directory kinds, then mount the presentation-only list.

Desktop renders recursively (`TreeBlock` → `DirRow` / `FileRow`). Mobile renders
one level at a time via route params.

## Editor tabs and untitled documents

The writer-facing destination is **Editor**. `ContextPaneController` owns route
reconciliation, tab selection/close behavior, last-route restore, work-scoped
pruning, and scroll restoration. `ContextTab` has three variants: `tracked`,
`viewer`, and the in-memory `{ kind: "new", documentId }` placeholder. A new tab
uses an ordinary `DocumentSession` from its first render, created detached so
Y.Doc + IndexedDB exist without opening an unauthorized server room.

`untitled-reconciler.ts` is the only materialization engine. Its localStorage
registry (`meridian:pending-untitled`) contains only `{documentId, projectId,
home}` entries appended when a candidate first becomes non-empty. Events only
schedule the same deferred, idempotent sweep. The sweep creates through
`create-untitled`, attaches the existing Y.Doc, waits for confirmed provider
sync, then drains the entry. A closed tab is not special: the same entry drives
a headless attach/flush. A never-materialized empty is the only path that clears
IndexedDB. A foreign UUID conflict clones the Yjs state into a newly minted
detached session and replaces the new tab's identity in place before retrying.
Named/viewed documents never enter this engine.

After create returns, the placeholder becomes a normal route-owned `tracked`
tab in place. `provisionalName` comes from the tree DTO and controls the rename
line; a cached tree refetch refreshes open-tab metadata so a cross-device rename
eventually dissolves the line without another invalidation channel.

`UntitledRenameLine.tsx` survives only as the ambient provisional rename line.
It is the lower-priority tenant of `EditorBannerSlot` (draft chrome wins), uses
the URI-shaped field and local collision browser, and commits basename-only on
Enter. There is no Save button and no content handover. While the pending entry
exists it shows the amber “Only on this device” badge; the badge disappears only
when the reconciler confirms server sync. Server 409 remains a race guard with
Open-existing recovery. Moving remains a tree action.

The tab strip still follows the settled tonal treatment: it paints nothing,
active tabs continue the canvas upward, inactive neighbors alone receive short
dividers, and the whole chip is the tab target.

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
