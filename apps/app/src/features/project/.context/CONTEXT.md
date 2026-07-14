# features/project — Desktop project shell

The authenticated project project: one persistent multi-panel desktop surface
that swaps primary *destinations* (Home / Chat / Editor) without tearing down
its stateful surfaces. This file is the colocated contract for the shell — read
it before touching layout, the rails/headers, or the prefs store.
Settings is an auxiliary routed surface, not a primary destination.

Design intent lives in [`DESIGN.md` § Project shell](../../../../../../DESIGN.md);
the model/view continuity rationale is the KB decision
[persistent-surfaces-lift](persistent-surfaces-lift decision).
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

- **`rail-l`** — the left sidebar (destinations + project file tree).
- **`center`** — the destination's main pane (Home/Settings route pane, or the
  Chat/Editor center surface).
- **`dock`** — the shared right dock. Chat occupies it on Home/Editor; the
  context-rail occupies it on the Chat screen. It reads as **one persistent
  sidebar** whose inner content swaps — a single shared width/collapse pref
  (`slotPrefs.dock`), not a per-surface one.

There is **no `files` grid track**. The file explorer is the persistent body of
the left sidebar; `ContextViewer` owns only the Editor tab strip and document.

`LeftSidebar` is one column with a linked wordmark, Home/Chat/Editor navigation,
the persistent project tree, and account controls. The navigation rows are
shared with mobile through `WorkspaceNavBody`; the wordmark and recursive tree
are desktop shell grammar.

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

**Seam invariant (amended for tab-direction E):** the top `h-10` band of the
center slot paints **only chrome-step or canvas tokens** — `ContextTabBar` is
the recessed chrome band (`bg-sidebar-accent`) and the active tab is canvas
(`bg-background`), so the rail corner notches meet chrome-on-chrome, a
deliberate tonal step rather than a color-matched third tint. Arbitrary surface
tokens (e.g. `bg-surface-subtle`) remain banned in this band: they re-expose
the notch wedge on palette change. Only `--color-background`,
`--color-sidebar`, and `--color-sidebar-accent` may meet at that seam. This
keeps future palette swaps safe with zero color-matching.

## One sidebar grammar (the reconciliation)

The shell once had four bespoke "sidebar + header + collapse + resize" surfaces
that had each drifted (different header heights, borders, toggle positions, label
weights, raw colors). They are now reconciled to **one reference: the left
sidebar (`shell/LeftSidebar.tsx`).** New surfaces follow it. The load-bearing
conventions:

- **Header row = `h-10` (40px), `border-b border-border-subtle`, `px-2`.** Every
  header reads at the same height: left wordmark, dock/rail header, files
  header, editor header. Use `border-border-subtle`, not `border-border`.
  **Exception — the context tab strip**: same `h-10`, but tonal separation and
  **no bottom border** (tab-direction E; see the seam invariant above). Do not
  reintroduce a rule under the strip.
- **One collapse/expand control: `shell/PanelToggleButton.tsx` (`size-8`),
  inset `px-2`.** This is the canonical toggle column. **Invariant — "click
  without moving the mouse":** a surface's collapse button and the matching
  expand control that appears after it collapses MUST sit at the same screen-x.
  That only holds if every surface uses the *same* `px-2` inset; mixing insets
  breaks it. (This `px-2` deliberately supersedes the earlier `px-1` alignment
  from commit `30fa8a0`; `px-2` matches the LeftSidebar/PaneHeader reference.)
- **Status color via tokens** — `text-status-streaming`, `text-destructive` —
  never raw `emerald-*` / `rose-*`.

The repeating chrome is extracted only where it actually repeats
(`RailHeader`, `PaneHeader`, `PanelToggleButton`) — not as
a god "RailShell" wrapper, because the chat dock is a `motion.div`, not a
`ResizablePanel`, and cannot be wrapped in a panel-baking shell.

## Surfaces & preferences

Stable surface ids (`layout/types.ts`): `threads`, `chat`, `context-viewer`,
`context-rail`.

`layout/surface-prefs-store.ts` is the **device-local** chrome-prefs store
(Zustand `persist`, localStorage key `meridian:project-surface-layout`,
`version: 3`). It stores width + collapsed per surface, plus the
shared `slotPrefs.dock`. **Slot placement is NOT stored** — it is a pure function
of the active screen, merged into a render-time `SurfaceLayoutMap` by the
placement module. `DEFAULT_*`/`*_WIDTH_BOUNDS` are the clamps.

Browser-storage keys use `meridian:` + kebab-case. Scope per-project/per-work/per-file
state inside the persisted value, not by appending entity ids to the key.

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
(`?screen=`, `?thread=`, `?scheme=`, `?folder=`, `?path=`, `?ext=`) and is the
single source of screen/thread ownership. The per-screen controllers
(`HomePaneController`, `ChatPaneController`, `ContextPaneController`,
`SettingsPaneController`) are **controlled** — they render into surfaces and call
the route's handlers; they never set the URL directly. (Full ownership rules:
[`apps/app/.context/CONTEXT.md` § Project workspace screen routing](../../../../.context/CONTEXT.md).)

The **Editor** destination retains `ContextPaneController` as its implementation
name. It owns URL/tab reconciliation, route-validated opens, temporary-tab
projection, close fallbacks, and scroll restoration. `ContextViewer` and
`ContextTabBar` are controlled views. The tab strip also owns the collapsed
sidebar/dock expand controls; Editor therefore supplies no separate route pane
or header band.

Chat switching lives in `features/chat/ThreadSwitcherPopover`: it filters by
chat title, groups chats by Work when grouping is meaningful, shows recency and
attention, and supports keyboard switching. Rename is available on the active
row; new chat remains a footer action. The route owner performs the actual
thread switch.

## Don't

- Don't hardcode a surface background — let the slot paint the material.
- Don't introduce a second toggle inset value — `px-2` is the column.
- Don't reparent/unmount stateful surfaces on screen change — move the grid-area.
- Don't gate a mount between hook calls — gate at the parent.
- Don't add raw hex/rgba or `emerald`/`rose` — use semantic tokens.
