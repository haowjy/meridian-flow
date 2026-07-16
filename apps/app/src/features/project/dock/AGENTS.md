# features/project/dock — Dock view container + Changes settle surface

## Purpose

The right dock is a **view container** that sits in the project shell's `dock`
grid slot. It has per-screen view sets (Chat-main: Context | Changes;
Context-main: Chat | Changes) and a single header row with a contained
segmented switch.
The **Changes** view is the work-scoped settle surface: every document with
pending AI changes, grouped with per-operation review cards carrying Apply /
Discard / Undo.

This is NOT the chat surface or the context rail — those are the dock's
*occupants* (`ChatSurface`, `ContextSidebar`), wrapped by `DockShell`. The dock
itself owns only the view-switch chrome, the view store, and the Changes view
body.

## Mental model

`DockShell` wraps the dock occupant's native body in both placements:

- **`center` placement**: passthrough — no header, no Changes swap. The occupant
  is a normal center pane. This keeps the chat surface at the same tree depth
  across center↔dock moves so React never reconciles it away.
- **`dock` placement**: the `DockHeader` appears, and the body is hidden + inert
  when the writer switches to the Changes view. The primary body **stays mounted**
  — chat survives a view switch the same way it survives a collapsed dock.

`useDockView(screen)` resolves the active view from a session-only store. The
view set for each screen is fixed; the default is the occupant's native view.

## Key rules

1. **Surface-parking invariant.** The occupant's native body (`children`) must
   sit at the same React tree depth in both center and dock placements. A
   placement change is a grid-area move, never a remount. If the dock occupant
   relies on a different wrapper for center vs. dock, the invariant is broken.

2. **Primary body stays mounted when Changes is active.** Do not unmount
   `children` when `view === "changes"` — hide it (opacity-0, inert). Chat state
   and document sessions must survive a view switch.

3. **resolveDockView is a pure fallback.** `resolveDockView(screen, stored)` is
   a pure function with no React dependency — testable in isolation. It defaults
   to the occupant's native view when no stored choice exists, and falls back
   when a stored choice is invalid for the current screen's set.

4. **Session-only view store.** `useDockViewStore` has no `persist`. A fresh
   reload starts from defaults — no stale view survives. Placement, width, and
   collapse are owned by the surface-prefs store; this store only tracks the view
   choice.

5. **One label source.** `DockViewLabel` is the single place dock view labels
   are spelled. The segmented switch is the only place the view identity
   appears — the header has no separate section title.

6. **The switch stays inside the dock material.** Its recessed track provides
   a complete boundary. The active segment may use page paper only inside that
   boundary; it never connects to the page like a tab chip.

## Anti-patterns

- **Don't unmount the primary body.** It breaks the surface-parking invariant
  and loses chat state.
- **Don't add a badge or count to the Changes segment.** Discovery lives
  in the composer DraftDock strip.
- **Don't persist the dock view choice.** A stale view across reloads is worse
  than starting fresh.
- **Don't add a tailwind-merge dependency on `border-border-subtle`.** See the
  tailwind-merge trap in `.context/CONTEXT.md`.

## Files

| File | Role |
|---|---|
| `DockShell.tsx` | View container shell: passthrough in center, header + Changes overlay in dock |
| `DockHeader.tsx` | Single `h-10` header: left slot (chat title), contained segmented switch, close |
| `dock-view-store.ts` | Session-only Zustand store + `resolveDockView` pure fallback |
| `DockChangesView.tsx` | Work-scoped Changes view: document groups + operation card list |
| `ReviewOperationCard.tsx` | Per-operation card with Apply / Discard / undo receipt |
| `operation-change-text.ts` | Pure card-body text extraction from operations/hunks |

## Downlinks

- [`.context/CONTEXT.md`](.context/CONTEXT.md) — contracts, architecture, tailwind-merge trap, runtime registration seam
- [`../.context/CONTEXT.md`](../.context/CONTEXT.md) — project shell layout, slot topology, surface-prefs store
- [`../../chat/AGENTS.md`](../../chat/AGENTS.md) — draft review controller, docked-drafts, DraftDock composer strip
- [`../../editor/DraftReviewHeader.tsx`](../../editor/DraftReviewHeader.tsx) — full-width editor review chrome
- [KB: Draft Review Lifecycle](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/draft-review-lifecycle.md)
- [Design history: dock tabs](https://github.com/haowjy/meridian-flow-docs/blob/main/work/writer-ux/notes/design-dock-tabs.md)
