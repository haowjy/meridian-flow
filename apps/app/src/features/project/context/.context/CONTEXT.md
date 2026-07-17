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
              ├─ DocumentIdentityBar (active tab's breadcrumb + chip slot)
              ├─ ContextEditorMountHost (warm tracked + untitled Yjs editors)
              ├─ ContextViewerHost (active binary viewer)
              └─ EditorBannerSlot (draft chrome only)
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
tab in place. `provisionalName` comes from the tree DTO and drives the identity
bar's provisional state; a cached tree refetch refreshes open-tab metadata so a
cross-device rename eventually dissolves the state without another invalidation
channel.

## Document identity bar

`DocumentIdentityBar.tsx` is the one identity surface: a ~22px mono breadcrumb
band (`Scratch › Untitled 4`) at the top of the active tab's canvas, on every
document — tracked, provisional, viewer. Provisional docs are a *state* of the
bar (italic leaf + jade “Choose a home” chip), never separate chrome; the
editor banner slot below the toolbar belongs to draft chrome alone, and
identity chrome must never occupy it again (structural separation, 2026-07-17).

Contracts:

- **Keystroke path**: at rest the bar renders from tab metadata only. The
  content-suggestion observer (300ms debounce, `writerOwnsName` latch) mounts
  only while the edit field is open on a provisional doc.
- **Edit mode** (phase 1): click the path → basename field with the folder
  prefix as read-only spans (`/` separators — typing grammar; rest renders
  `›`). Enter commits through the shipped rename seam (`renameContextEntry`
  for tracked, `queueUntitledRename` for `new`); Esc AND blur revert — Enter
  is the only commit. Basenames are whitespace-trimmed before validation and
  commit; whitespace-only input is name-required invalid. Validation reasons
  and collisions render live (300ms debounce) as a `ValidationNote` under the
  bar; collision adds Open-existing recovery. Full-path editing and the
  move-first popup land with the cross-folder move seam (phase 2); until then
  viewer tabs keep tree-action rename.
- **Queued-rename receipts**: a `new`-tab rename applies when the document
  materializes; its outcome is reconciler *state*
  (`queuedRenameFailure(documentId)`), never a promise — the edit session is
  over when the intent is queued. A failed receipt reopens the field with the
  writer's name restored and the conflict/error recovery note; the receipt
  clears when the writer edits or leaves the field. Failures must never drop
  silently.
- **Chip slot**: single occupancy, right edge. Provisional documents carry the
  jade "Name this draft" invitation — clicking opens the naming field, and the
  copy says so. Named documents carry no chip in phase 1: the standing
  "Choose a home" move chip arrives with the move-first popup, and no enabled
  control may promise a move it cannot perform. The device-only warning
  (warning tokens, `TriangleAlert`) outranks the invitation after unsynced
  words persist for a 2s sustained grace — the clock is the reconciler's
  per-document `pendingSince`, so remounting chrome (tab switches) cannot
  restart the window. Server 409 remains a race guard with Open-existing
  recovery.

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
