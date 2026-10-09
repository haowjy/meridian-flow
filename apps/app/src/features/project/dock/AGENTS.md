# features/project/dock — Dock view container, document slot, Changes settle surface

## Purpose

The right dock is a **view container** that sits in the project shell's `dock`
grid slot. It has per-screen view sets (Chat-main: Context | Changes;
Work/Editor-main: Chat | Changes) and a single header row with a contained
segmented switch. It can also hold **one document** on Work and Chat, shown in
the standard editor and replacing the views (and their switch) until closed. Work
Files notes open there on the Work screen; a note picked from the rail's Scratch section
opens there on the Chat screen only (`use-open-scratch-note.ts`), as does a Recent
row of the context rail (an id-keyed door through the navigation adapter).
The **Changes** view is the work-scoped settle surface: every document with
pending AI changes, grouped into server-vended Discard-class cards carrying
selective Discard. Document-level Apply all stays in the review header. It works on every
screen, with or without a mounted manuscript, so
entering review never has to leave the screen the writer is on.

This is NOT the chat surface or the context rail — those are the dock's
*occupants* (`ChatSurface`, `ContextSidebar`), wrapped by `DockShell`. The dock
itself owns only the view-switch chrome, the view store, and the Changes view
body.

## Mental model

`DockShell` wraps the dock occupant's native body in both placements:

- **`center` placement**: passthrough — no header, no Changes swap. The occupant
  is a normal center pane. This keeps the chat surface at the same tree depth
  across center↔dock moves so React never reconciles it away.
- **`dock` placement**: the caller-supplied header slot renders (`DockHeader`
  on desktop, `mobile/MobileChatSheetHeader` for the phone chat sheet), and the
  body is hidden + inert when the writer switches to the Changes view. The
  primary body **stays mounted** — chat survives a view switch the same way it
  survives a collapsed dock.

`useDockView(screen)` resolves the active view from a session-only store. The
native view is always present; Changes joins it only while `hasDockChanges`
finds an active draft.

## Key rules

1. **Surface-parking invariant.** The occupant's native body (`children`) must
   sit at the same React tree depth in both center and dock placements. A
   placement change is a grid-area move, never a remount. If the dock occupant
   relies on a different wrapper for center vs. dock, the invariant is broken.

2. **Primary body stays mounted when Changes or a document covers it.** Do not
   unmount `children` — hide it (opacity-0, inert). Chat state and document
   sessions must survive a view switch.

3. **resolveDockView is a pure fallback.** `resolveDockView(screen, stored)`
   is a pure function with no React dependency — testable in isolation. It defaults
   to the occupant's native view when no stored choice exists and falls back when a
   stored choice is invalid for the current screen's set.

4. **Session-only view store.** `useDockViewStore` has no `persist`. A fresh
   reload starts from defaults — no stale view survives. Placement, width, and
   collapse are owned by the surface-prefs store; this store only tracks the view
   choice.

5. **One label source.** `DockViewLabel` is the single place dock view labels
   are spelled, and `DockViewSwitch` is the one place that renders the segmented
   switch (`components/ui/segmented-tabs`, shared with the chat index filter) —
   the header has no separate section title. The left slot belongs to the
   occupant: the chat puts its switcher there (the dock has no chat index).
   `DockShell`'s `renderHeader` slot is what lets the phone chat sheet use its
   own header (`mobile/MobileChatSheetHeader`) instead of `DockHeader`, which
   stays desktop-only.

6. **The switch stays inside the dock material.** Its recessed track provides
   a complete boundary. The active segment may use page paper only inside that
   boundary; it never connects to the page like a tab chip.

7. **Empty Changes is absent.** `dockRows` is the shared active-row projection.
   `DockShell` uses its `hasDockChanges` wrapper for segment visibility, while
   `DockChangesView` renders the projected rows directly.

8. **The dock document is the standard editor, not a viewer.** It mounts
   `ContextDocumentHost` (the same host the Editor's tabs render through) and
   `DocumentPaneChrome`, so session, saving, offline, archived and review behaviour
   are the Editor's. Never give it a session, room, or capture of its own, and never
   paint a background on it: the dock slot owns the material. It is never held on the
   Editor screen (documents open as tabs there) or on the phone (full-screen editor).
   Rail switches hand off only the visible document between Editor and Chat; Work
   receives none. Peeks and Close do not change Editor tabs. Browser history and phone
   navigation do not hand off. The slot and Editor tabs remain separate owners.
   Picking a view on its screen replaces it; `DockShell` keeps the occupant mounted
   and inert behind it.

## Anti-patterns

- **Don't unmount the primary body.** It breaks the surface-parking invariant
  and loses chat state.
- **Don't add a badge or count to the Changes segment.** Discovery lives
  in the composer DraftDock strip.
- **Don't show an empty Changes segment.** When its final row disappears,
  `DockShell` returns to the occupant's native view.
- **Don't give the dock document its own session or a viewer.** It is the
  Editor's host and chrome; a read-only preview, a second Y.Doc, or a
  `bg-background` shell around it are all bugs.
- **Don't persist the dock view choice.** A stale view across reloads is worse
  than starting fresh.
- **Don't add a tailwind-merge dependency on `border-border-subtle`.** See the
  tailwind-merge trap in `.context/CONTEXT.md`.

## Downlinks

- [`.context/CONTEXT.md`](.context/CONTEXT.md) — contracts, architecture, tailwind-merge trap, runtime registration seam
- [`../.context/CONTEXT.md`](../.context/CONTEXT.md) — project shell layout, slot topology, surface-prefs store
- [`../../chat/AGENTS.md`](../../chat/AGENTS.md) — draft review controller, docked-drafts, DraftDock composer strip
- [`../../editor/DraftReviewHeader.tsx`](../../editor/DraftReviewHeader.tsx) — full-width editor review chrome
- [KB: Draft Review Commands Keep Authority on the Server](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/draft-review-command-authority.md)
