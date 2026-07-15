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

`TempDocumentEditor` is a standalone TipTap editor sharing the tracked
document's writing surface: the same centered `max-w-3xl` prose column,
`meridian-editor` prose contract, and docked toolbar alignment as `EditorView`
— nothing may jump when switching between temp and tracked tabs. Its chrome
follows the no-lines direction (tab-direction E): recessed tab strip above
(shared via `ContextTabBar`), save row directly on canvas — no fill, no rule.
The status copy is "Only on this device" in warning amber — the one line
telling the writer their words aren't in the project yet (honest about
`localStorage` persistence; cinnabar would read as error). Destination and
name fields lift on `bg-card`. The row is **always one line and never
clips**: the shell around the prose column is `overflow-hidden`, so hard field
floors would push Save out of view at narrow pane widths. Instead the row is a
`@container` — fields shrink freely (`min-w-0 flex-1` under max caps), and
below the `@md` container width the connector words drop and the warning
collapses to a tooltipped amber icon so the honesty signal survives. Only
failure/conflict notices may add a second line. Save is the only
primary-weighted button.
The prose column geometry is owned by `features/editor/editor-column.ts` —
one set of classes for chrome rows (toolbar, save bar) and one for the canvas
wrapper, encoding the inset arithmetic (`chrome = canvas-wrapper + prose`) in
one place. Both tracked and temp editors share it; changing it only here
keeps all surfaces aligned.

Toolbar details:
[../../../editor/.context/CONTEXT.md](../../../editor/.context/CONTEXT.md).

**Tab strip treatment (tab-direction E, settled 2026-07-13; band material
updated by slice 7):** separation is purely tonal — the strip paints
`bg-sidebar` (the ONE chrome material shared with the dock) with no bottom
border; the active tab is borderless `bg-background` with a rounded top and
Obsidian-style bottom flares (canvas-colored radial-gradient pseudos following
the tab's radius token), reading as the canvas continuing upward. Short
vertical dividers appear only against an inactive neighbor: between two
adjacent inactive tabs, and before the `+` control when the last tab is
inactive. No hairlines, no underline, no lift — the tonal step is the entire
selection signal. The whole chip is the tab's hit target (a transparent
overlay button; close floats above), and the inactive hover pill covers that
same full target. The strip is the chrome side of the three-tone invariant
(see [../../.context/CONTEXT.md](../../.context/CONTEXT.md)).

Saving adopts a **draft-while-editing** model: keystrokes in the URI field
never touch the hook — the field owns a local draft string — and the parsed
target is committed only at pick, blur, or submit. `save(target)` accepts
explicit values so a submit straight from typing never races the hook's async
state commits.

On save, an immutable content/destination/name/revision/**target-generation**
snapshot is captured up front. The durable context file is created, then the
editor navigates to it. The temp document is removed only when its current
revision AND target generation both still equal the snapshot's — a mid-flight
rename or re-destination survives (`newer-target` failure). A later local
revision stays open after the snapshot saves (`newer-words` failure), so newer
words can never be silently discarded, even when the earlier snapshot landed.
A path conflict offers the existing file or a rename.

A synchronous `inFlightRef` guards re-entry: a second Enter/click in the same
tick would pass a state-based check, since React state commits async.
Collision validation is live (local tree lookup) surfaced through the app's
one `ValidationNote` standard (`validation-note.tsx`) — the same look as the
tree's rename overlay. The server 409 is a race guard, not the primary UX. Closing a non-empty
temp document requires an explicit discard confirmation.

Tree creation state belongs to `TreeCreationProvider`; it is not
controller-local state. It backs the sidebar tree's scheme-targeted inline
create only. Every "new document" affordance in the Editor pane (tab-strip `+` — tooltip
"New tab", not "New draft" or "New temporary document" — and the empty state)
starts a temporary document instead — location is chosen at save time, never
hardwired to a scheme.

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
