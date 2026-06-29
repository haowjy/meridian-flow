# features/project — Desktop project shell

The authenticated project project: one persistent multi-panel desktop surface
that swaps *destinations* (Home / Chat / Context / Settings) without tearing down
its stateful surfaces. This file is the colocated contract for the shell — read
it before touching layout, the rails/headers, or the prefs store.

Design intent lives in [`DESIGN.md` § Project shell](../../../../../../DESIGN.md);
the model/view continuity rationale — stable surfaces that move by grid-area,
never reparented or unmounted — is the contract below (see
[Layout: one flat grid, stable surfaces](#layout-one-flat-grid-stable-surfaces)).
This page is the *implementation* contract.

Mobile now lives beside this desktop shell as a sibling implementation. The
shared `ProjectView` selects `mobile/MobileProject` only through the phone
capability predicate in `usePhoneShell()`; desktop `ProjectShell` remains the
persistent multi-panel grid. Phone-specific contracts live in
[`mobile/.context/CONTEXT.md`](../mobile/.context/CONTEXT.md).

## Layout: one flat grid, stable surfaces

`layout/SlotGrid.tsx` renders the whole project as a **single flat CSS grid**.
Every stateful surface is a permanent direct child of one grid container for the
entire session. A placement change only mutates the surface wrapper's
`grid-area` (or parks it offscreen via `PARKED_SURFACE_STYLE` when inactive).
**Surfaces are never portaled, reparented, or conditionally removed by a screen
change** — that is what preserves chat scroll/draft and live document sessions
across navigation.

Slot topology (`layout/desktop-layout.ts`), one grid row across every screen:

```
"rail-l  left-resize  center  dock-resize  dock"
```

- **`rail-l`** — the left sidebar (threads).
- **`center`** — the destination's main pane (Home/Settings route pane, or the
  Chat/Context center surface).
- **`dock`** — the shared right dock. Chat occupies it on Home/Context; the
  context-rail occupies it on the Chat screen. It reads as **one persistent
  sidebar** whose inner content swaps — a single shared width/collapse pref
  (`slotPrefs.dock`), not a per-surface one.

There is **no `files` grid track**. The Context file explorer renders *inside*
`ContextViewer`, below the tab strip — not as its own column.

### Slot paints the material; surfaces must not

Slot chrome — background, rounded inside corner, inward shadow — is owned
**entirely by the slot's `className`** (`DESKTOP_PROJECT_SLOTS`):

| Slot     | Material |
|----------|----------|
| `rail-l` | `bg-sidebar` + `rounded-r-xl` + `shadow-rail-left` |
| `dock`   | `bg-sidebar` + `rounded-l-xl` + `shadow-rail-right` |
| `center` | `bg-background` |

A surface that hardcodes its **own** background overrides the slot it sits in and
produces the classic white-band / green-flash bugs (e.g. an old `bg-background`
on `ChatSurface` painting a brighter band under the dock header). **Let the slot
paint.** `SlotGrid` never branches on slot kind — chrome is pure data.

**Seam invariant:** the top `h-10` band of the center slot must never paint its
own background — rail corner notches reveal the canvas token (`bg-background`),
so only `--color-background` and `--color-sidebar` may meet at that seam. Per-tab
or per-control fills inside the band are fine; a strip-wide third tint (e.g.
`bg-surface-subtle` on `ContextTabBar`) re-exposes the notch wedge on palette
change. This keeps future palette swaps safe with zero color-matching.

## One sidebar grammar (the reconciliation)

The shell once had four bespoke "sidebar + header + collapse + resize" surfaces
that had each drifted (different header heights, borders, toggle positions, label
weights, raw colors). They are now reconciled to **one reference: the left
sidebar (`shell/LeftSidebar.tsx`).** New surfaces follow it. The load-bearing
conventions:

- **Header row = `h-10` (40px), `border-b border-border-subtle`, `px-2`.** Every
  header reads at the same height: left wordmark, dock/rail header, context tab
  strip, files header, editor header. Use `border-border-subtle`, not
  `border-border`.
- **One collapse/expand control: `shell/PanelToggleButton.tsx` (`size-8`),
  inset `px-2`.** This is the canonical toggle column. **Invariant — "click
  without moving the mouse":** a surface's collapse button and the matching
  expand control that appears after it collapses MUST sit at the same screen-x.
  That only holds if every surface uses the *same* `px-2` inset; mixing insets
  breaks it. (This `px-2` deliberately supersedes the earlier `px-1` alignment
  from commit `30fa8a0`; `px-2` matches the LeftSidebar/PaneHeader reference.)
- **One section label: `shell/SidebarSectionLabel.tsx`** ("Chats" / "Context" /
  "Files"). It pins **`font-normal`** because the `text-meta` token sets only
  font-*size*, not weight — without the pin, each label inherits its ancestor's
  weight and they diverge (the 400-vs-500 mismatch). Do not restyle the call
  sites; feed them text only.
- **Status color via tokens** — `text-status-streaming`, `text-destructive` —
  never raw `emerald-*` / `rose-*`.

The repeating chrome is extracted only where it actually repeats
(`RailHeader`, `PaneHeader`, `PanelToggleButton`, `SidebarSectionLabel`) — not as
a god "RailShell" wrapper, because the chat dock is a `motion.div`, not a
`ResizablePanel`, and cannot be wrapped in a panel-baking shell.

## Surfaces & preferences

Stable surface ids (`layout/types.ts`): `threads`, `chat`, `context-viewer`,
`context-rail`.

The Context files panel (`context-files`) has its **own** store
`context/context-files-store.ts` (key `meridian:context-files-panel`), rehydrated
in the same `_authenticated.tsx` effect behind the same project gate.

`layout/surface-prefs-store.ts` is the **device-local** chrome-prefs store
(Zustand `persist`, localStorage key `meridian:project-surface-layout`,
`version: 3` with a migration). It stores width + collapsed per surface, plus the
shared `slotPrefs.dock`. **Slot placement is NOT stored** — it is a pure function
of the active screen, merged into a render-time `SurfaceLayoutMap` by the
placement module. `DEFAULT_*`/`*_WIDTH_BOUNDS` are the clamps.

## Reload stability — the hydration gate (load-bearing)

The shell previously hit an intermittent **"Maximum update depth exceeded"** loop
on reload. Root cause: non-atomic prefs hydration racing with a redundant
whole-prefs subscription and a double-firing tab effect. The fix is structural
and must not be regressed:

1. The prefs store persists with **`skipHydration: true`**.
2. `routes/_authenticated.tsx` calls `useProjectSurfacePrefsStore.persist
   .rehydrate()` (synchronous — localStorage) then `setHydrated()` immediately.
3. **`ProjectView` gates the whole `DesktopProject` mount on `_hydrated`** so it
   mounts exactly once against final persisted prefs (at most one frame, no
   visible flash).

Two rules keep this stable:

- **Gate at the parent (`ProjectView`), never inside `DesktopProject`.** A
  conditional `return null` placed *between* hook calls is a Rules-of-Hooks
  violation ("Rendered more hooks than during the previous render"). Hoist the
  gate above the component that runs the hooks.
- **`DesktopProject` takes a single merged layout subscription**
  (`useProjectLayout`). Do not add a second whole-prefs subscription — that
  redundant subscription was part of the original cascade.

Related: `ContextPaneController`'s route-tab auto-open guard **re-arms** once the
route stops needing a tab (`openedKeyRef` cleared when `!needsRouteTab`), so
close-then-reopen of the same file works and the guard can't re-enter the
hydration cascade.

## Screen routing & controllers

`routes/_authenticated/project/$projectId.tsx` owns **all** workspace URL params
(`?screen=`, `?thread=`, `?scheme=`, `?folder=`, `?path=`, `?results=`) and is the
single source of screen/thread/document ownership. The per-screen controllers
(`HomePaneController`, `ChatPaneController`, `ContextPaneController`,
`ContextViewerSurfaceController`) are **controlled** — they render into surfaces
and call the route's handlers; they never set the URL directly. (Full ownership
rules: [`apps/app/.context/CONTEXT.md` § Project workspace screen routing](../../../../.context/CONTEXT.md).)

Two document-open handlers (see
[Surface-aware document open](#surface-aware-document-open-single-path) above):
`handleSetActiveDocument` (keep current screen) and `handleSelectContextPath`
(switch to Context). `handleSelectScreen` no longer clears `scheme`/`path` —
the active document persists across screen switches.

## Editable context rail — shared `ActiveDocumentSurface`

The rail (Chat screen) renders the active document through the same
`context/ActiveDocumentSurface` component as the center pane (Context screen).
Both call-sites mount a `ContextEditorMountHost` with **distinct registry owners**
(`desktop-context-editor-mount-host` vs `context-rail-active-document-surface`),
so each surface retains its own open-document set without racing the other's
session reconciliation.

**Decision: editable, not read-only.** The original design (open question #2 in
the architecture doc) recommended read-only for v1. Product reversed this:
the rail is a full editor — same formatting toolbar, collab cursors, and Yjs
sync as the center pane. The `ReadOnlyDocHost` shared component now serves
only the phone shell (`mobile/MobileDocumentHost`).

For the shared-architecture rationale, see the KB decision
[shared-document-surface](shared-document-surface decision).

### Scroll-restore is owner-scoped

`ContextEditorMountHost` stamps `data-context-editor-owner` on each editor
wrapper div (the `editorOwner` prop, which centers on the registry owner).
`ContextPaneController`'s scroll-restore effect calls `findEditorScroller`
with `DESKTOP_CONTEXT_EDITOR_OWNER`, so it only queries editors owned by the
center pane — the parked rail editor is invisible to the center's scroll
restoration. No cross-talk.

## Surface-aware document open — single path

All document opens funnel through `handleOpenInRail` in
[`ProjectView.tsx`](ProjectView.tsx). The popover, the rail tree, and
chat document links all call it. Routing is screen-aware:

- **Context screen, center-browsable scheme** (manuscript, kb, user) →
  opens in the center pane — `onSetActiveDocument` updates the URL without
  changing screens.
- **Chat screen, Home screen, or `uploads` scheme** → `openChatRail()`
  switches to Chat (if needed) and expands the dock, then
  `onSetActiveDocument` sets the URL. The rail derives viewer mode from
  the URL.
- **Thread uploads** (non-routable, `scheme` = null) → switches to Chat,
  sets `railUploadTarget` (rail-local state, no URL update).

### `dismissedDocKey` model

When the writer clicks "← Back" in the rail viewer, the dismiss is stored as
a key (`scheme:path`), not a render-phase boolean. The rail derives
`railViewerDismissed` as `dismissedDocKey !== null && dismissedDocKey === docKey`.
This resets on `activeThreadId` change and clears when a new document is
selected — so a dismiss survives React re-renders but not a thread switch.

### `handleSetActiveDocument` vs `handleSelectContextPath`

The route (`$projectId.tsx`) has two distinct handlers:

- **`handleSetActiveDocument(path, scheme)`** — updates `scheme`/`path`/`folder`
in the URL WITHOUT changing `screen`. Used by `handleOpenInRail` and the rail
file-tree click.
- **`handleSelectContextPath(path, scheme)`** — sets `screen: "context"` IN
ADDITION to `scheme`/`path`/`folder`. Navigates to the Context screen.

`handleSelectScreen` no longer clears `scheme`/`path` — the active document
persists across screen switches, same as `thread`.

## Known limitation — dual editor binding for the active doc

The `active`-gate in `ContextPaneController` only suppresses *route-driven*
auto-opens — an **already-open** center tab stays mounted while parked offscreen.
So opening a doc on Context, switching to Chat, then opening the *same* doc in the
rail yields **two `EditorView`s bound to one shared `Y.Doc` + awareness**. Content
stays correct (canonical Yjs split-pane), but the writer may see their own cursor
flicker/echo while both surfaces are live.

**Decision: accepted for now (KISS)** — requires a deliberate stale-tab sequence
and never corrupts content. The better fix (share the single mounted active-doc
editor across both surfaces) is tracked in
[issue #117](https://github.com/haowjy/meridian-flow/issues/117).

## Don't

- Don't hardcode a surface background — let the slot paint the material.
- Don't introduce a second toggle inset value — `px-2` is the column.
- Don't style section-label call sites — use `SidebarSectionLabel`.
- Don't reparent/unmount stateful surfaces on screen change — move the grid-area.
- Don't gate a mount between hook calls — gate at the parent.
- Don't add raw hex/rgba or `emerald`/`rose` — use semantic tokens.
- Don't open documents by navigating to the Context screen unless the writer
explicitly asked to switch — use `handleOpenInRail` (screen-aware).
- Don't share a `registryOwner` key across concurrently-mounted editor hosts.
- Don't clear `scheme`/`path` on screen switch — the active document persists.
