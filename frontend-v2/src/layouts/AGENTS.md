# Layouts — Mode Shells

> **Status:** Phase 6 — not yet started. Folder structure scaffolded;
> no components, no stories, no styles. This AGENTS.md documents the
> intended architecture and invariants for implementers.

## What Lives Here

Five subdirectories, currently empty skeleton:

| Directory | Responsibility |
|---|---|
| `app-shell/` | Outermost frame: Rail, BottomNav, StatusBar, grid shell, mode-switch controller |
| `agents/` | Agents mode shell: session dashboard + thread detail pane |
| `converse/` | Converse mode shell: thread pane + collapsible editor pane |
| `studio/` | Studio mode shell: FileExplorer + editor + sidecar |
| `shared/` | Shared layout primitives: pane wrappers, resizable wrappers, drawer/sheet adapters |

## Prime Invariants (Do Not Break)

These are the architectural constraints. The design spec is the canonical
source for all layout decisions. See `_docs/design/layouts/overview.md`.

### 1. All Three Mode Shells Mounted Simultaneously

Agents, Converse, and Studio shells are all mounted at all times. Mode
switching is a **CSS visibility toggle** — not a React mount/unmount cycle.
The inactive shells are:

```css
.inactive-mode-shell {
  display: none;           /* removes from layout + accessibility tree */
}
```

Plus `aria-hidden="true"` and `inert` on the inactive container. This
preserves all state (scroll, cursor, drafts, expanded groups) across mode
switches. React effects and subscriptions stay mounted — see rule 2 for
what must pause.

On mode switch: **explicitly restore focus** to the last focused element
in the newly active mode via `element.focus()`.

### 2. Active/Inactive Work Contract

Inactive shells must pause non-essential work:

| Keeps running (essential) | Pauses while inactive |
|---|---|
| App-level WS connections + Yjs sync | Streaming UI animations (token-by-token text, spinners) |
| IndexedDB persistence | `ResizeObserver` / `IntersectionObserver`-driven layout |
| In-memory state (drafts, scroll, expanded groups, cursor) | `requestAnimationFrame` loops + polling timers |
| | Auto-scroll-to-bottom reactions to content growth |

When a shell becomes active again, paused work resumes. Deferred layout/
scroll reconciliation runs once on reveal.

See `_docs/design/layouts/overview.md` §Active/Inactive Work Contract.

### 3. Responsive Tiers Drive Shell Shape, Container Queries Drive Internals

Three tiers, detected via viewport media queries:

| Tier | Width | Nav surface | Pane model |
|---|---|---|---|
| Phone | < 600px | BottomNav (3 tabs + overflow) | Single pane, secondary via drawers/sheets |
| Tablet | 600–1199px | BottomNav (portrait < 900px) / Rail (landscape ≥ 900px) | Primary + toggle overlay or reduced split |
| Desktop | ≥ 1200px | Rail + StatusBar | Full multi-pane, resizable via drag handles |

**Rule:** viewport breakpoints for shell-level changes (nav surface, pane
count). Container queries for pane internals (component density, text
truncation, column count). See `_docs/design/foundations/responsive.md`.

### 4. PanelResizeHandle Is Pointer-Only

Drag-to-resize handles work on Desktop and Tablet landscape only. On Phone
and Tablet portrait, panes are full-screen or drawer/sheet — no continuous
resize. See `_docs/design/layouts/overview.md` §PanelResizeHandle on Touch.

### 5. Mode Is URL-Driven

TanStack Router drives mode from the URL:
- `/projects/{id}/agents/...`
- `/projects/{id}/converse/{threadId}`
- `/projects/{id}/studio/{documentPath}`

Mode switch is a CSS toggle + URL push — no data refetch. See
`_docs/design/layouts/overview.md` §Mode Switching.

### 6. State Scoping

| Scope | Examples | Storage |
|---|---|---|
| App-level | Active project, theme, WS connections | URL + localStorage + app contexts |
| Mode-level | Panel sizes, explorer collapsed, active Studio tab | localStorage + memory |
| Session-level | Thread scroll, editor cursor, composer drafts, expanded groups | memory (per-thread, per-document) |
| Persisted | Tabs, active thread, panel sizes, theme, Y.Doc content, proposals | localStorage + IndexedDB |

See `_docs/design/layouts/overview.md` §State Scoping.

## Perf Rules

### `content-visibility: hidden` for Inactive Shells

Inactive mode shells use `content-visibility: hidden` to skip browser
rendering for hidden-but-mounted DOM. For long transcripts (Converse turn
lists, Studio sidecar), use `content-visibility: auto`. See
`_docs/design/foundations/motion.md` §content-visibility.

### Mode Switching Is Instant (0ms)

No CSS transition on mode switch. The writer should never wait for a
mode animation. This is a hard constraint — do not add `transition` on
the shell visibility toggle.

### `100dvh` for Full-Height Mobile Surfaces

The mobile shell uses `100dvh` for full-height surfaces (fallback to
`100vh`). Safe-area insets on all fixed chrome (BottomNav,
AccessoryBar). See `_docs/design/foundations/responsive.md` §Viewport &
Safe Area Tokens.

## Subdirectory Details

### `app-shell/`

The outermost frame — always visible, never changes between modes.

**Components to build:**
- Rail (48px left column, mode icons + active indicator + settings)
- BottomNav (56px + safe-area, Phone/Tablet portrait replacement for Rail)
- StatusBar (24px bottom strip, connection indicator + credit balance;
  hidden on Phone/Tablet portrait)
- App shell grid (CSS grid: `48px 1fr` / `1fr 24px` on Desktop;
  `1fr` / `1fr auto` on Phone)
- Mode-switch controller (CSS visibility toggle + URL push + focus restore)

**Key rules:**
- Rail active indicator = 2px left `accent-fill` bar (not icon fill)
- Rail hit areas: 36px visual, 44px invisible hit-padding
- BottomNav "More" tab = settings + theme + connection status
- `Mod+1/2/3` switches modes on Desktop/Tablet with keyboard
- `aria-live="polite"` announces mode change

See `_docs/design/components.md` §Rail, §BottomNav, §StatusBar.

### `agents/`

The session orchestration surface.

**Layout:** Session dashboard (60%) + thread detail pane (40%), resizable.
Phone: dashboard full-screen, detail as push navigation.

**Components to build:**
- Session header (title, status badge, session selector dropdown)
- Thread family cards (WorkItemCard: title, status, thread tree, activity)
- Thread detail pane (turn list + simplified composer)
- Session selector bottom sheet (Phone)

**Key rules:**
- Cards show thread families (root + branches + spawns)
- Streaming indicator: teal pulse dot on active cards
- Empty state: "No active threads in this session"
- Cross-mode: "Open in Converse" switches mode

See `_docs/design/layouts/agents.md`.

### `converse/`

The chat-primary mode.

**Layout:** Thread pane (55%) + collapsible editor pane (45%), resizable.
Phone: thread full-screen, editor as push navigation.

**Components to build:**
- Thread header (title, thread selector dropdown, editor toggle)
- Turn list (via `FloatingScrollLayout` from `features/chat-scroll/`)
- Composer (CM6 editor at bottom, send/stop toggle)
- Editor pane (single-slot, no tabs — preview→promote to Studio)

**Key rules:**
- Document opens as transient preview (italic title); promotes to persistent
  Studio tab on edit/hunk action/pin/double-click
- Thread switching restores the target thread's saved composer draft
- Only newly created threads start with empty composer
- `Mod+Shift+O` = new thread; `Mod+/` = thread selector
- "Review" action expands editor pane, loads document, scrolls to first hunk

See `_docs/design/layouts/converse.md`.

### `studio/`

The editor-primary mode.

**Layout:** FileExplorer (200px) + TabBar + editor (~60%) + sidecar (~40%).
All resizable. Phone: editor full-screen, Explorer as drawer, sidecar as
bottom sheet.

**Components to build:**
- FileExplorer (tree with folders/files, context menu)
- TabBar (document tabs, preview tabs, overflow scroll)
- Editor area (CM6, title header with word count, proposal review toolbar)
- Chat sidecar (thread rendering in narrower pane)
- Fuzzy file open (`Mod+P`, cmdk popover)

**Key rules:**
- TabBar: preview tabs (italic, single slot, promote on commit);
  persistent tabs (upright, persisted to localStorage)
- Tab close: `×` affordance or middle-click; no global keystroke
  (`Mod+W` blocked by browser)
- FileExplorer: 16px indent per level, 28px row height
- Sidecar NOT auto-scoped to active document — manual thread selection
- "Discuss current document" (`Mod+Shift+G`) is explicit opt-in
- All pending hunks visible (document-scoped, from all threads)

See `_docs/design/layouts/studio.md`.

### `shared/`

Layout primitives reused across mode shells:

**Components to build:**
- Pane wrapper (collapsible, border, background)
- Resizable pane adapter (wraps `react-resizable-panels`)
- Drawer adapter (left/right, 85% width on Phone)
- Bottom sheet adapter (wraps `BottomSheet` from `components/ui/`)
- Overlay toggle (slide-in panel, 80% width, backdrop)

## Design Spec Pointers

| Concern | Canonical doc |
|---|---|
| App shell, mode switching, state scoping, CSS mounting, responsive tiers, responsive behavior per mode | `_docs/design/layouts/overview.md` |
| Agents layout, data model, session orchestration | `_docs/design/layouts/agents.md` |
| Converse layout, interaction flows, preview→promote | `_docs/design/layouts/converse.md` |
| Studio layout, tab lifecycle, sidecar, fuzzy file open | `_docs/design/layouts/studio.md` |
| Responsive tier system, viewport/safe-area tokens, touch rules | `_docs/design/foundations/responsive.md` |
| Composite components (Rail, TabBar, BottomNav, BottomSheet, etc.) | `_docs/design/components.md` |
| Motion/INP, `content-visibility` | `_docs/design/foundations/motion.md` |
| Keyboard map (mode switching, Studio/Converse/Agents shortcuts) | `_docs/design/interaction/navigation.md` |
| Editor in layouts (surface ownership, mirrored surfaces) | `_docs/design/interaction/editor.md` |
