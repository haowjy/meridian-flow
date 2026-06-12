# Notion — live product review

Live browser sampling on **notion.so only** (logged-in workspace app) across a viewport & zoom matrix, compared against Meridian Flow at `https://phase-1.app.meridian.localhost/` on the same matrix. Patterns only — not a visual clone of Notion.

**Sources observed**

| Surface | URL / state |
|---------|-------------|
| Notion block editor (onboarding) | `notion.so/Welcome-to-Notion-…` |
| Notion empty page | `notion.so/37796780…` (New page) |
| Meridian Flow home | `phase-1.app.meridian.localhost/` |
| Meridian Flow project workbench | `…/project/{id}` |

**Method:** CDP `Emulation.setDeviceMetricsOverride` for viewport width; `Emulation.setPageScaleFactor` for 75% / 125% zoom. Measurements via `getBoundingClientRect()` on sidebar and editor nodes.

---

## Summary

Notion is a **two-pane document shell**: a persistent left sidebar (workspace nav + page tree) and a **centered block editor** (~720px content column on desktop). The sidebar is ~270px and does not collapse on desktop until the user closes it. Mobile swaps the sidebar for a **full-height overlay drawer** opened from a top-bar menu; the editor becomes single-column with compact chrome. Browser zoom scales the **entire app uniformly** — layout breakpoints do not re-fire; no horizontal scroll observed at 125%.

Meridian Flow today is **conversation/workbench-first**: home uses a ~279px projects sidebar and the same ~720px centered column; in-project uses a slim **icon rail** plus card-based workbench (not a block editor). Mobile collapses navigation into a **TopBar hamburger → drawer** with project list drill-down and destination links — structurally similar to Notion’s overlay nav, but without page-tree nesting or block-level editing.

---

## Viewport & zoom matrix

| Matrix cell | Notion (observed) | Meridian Flow (observed) |
|-------------|-------------------|-------------------|
| **Desktop ~1280px+** (1440×900, 100%) | Sidebar **pinned** ~270px. Editor column **~720px** centered in remaining width. Top bar: breadcrumb (page + Private), Share / link / favorite / actions. Block page shows nested checkboxes, toggle, slash hints. New page shows **“Get started with”** pill row (Ask AI, AI Meeting Notes, Database, Form). | Home: projects sidebar **~279px**, `home-column` **~720px**. Project: **icon rail** (~48px) + workbench cards (stats, work items, recent activity). Input **14px**. |
| **Mobile ~390px** (390×844, 100%) | Sidebar **hidden** after close; **Open menu** in top bar. Drawer overlay reuses full desktop tree (Home/Chat/Meetings/Inbox tabs, Agents, Private tree, Library/Help/Trash, New chat footer). Editor **full width** with reduced side padding; title + blocks stack vertically. New-page pills **truncate/wrap** (Ask AI + …). AI FAB bottom-right. | **Open navigation** in TopBar; drawer lists New project, recent projects, destinations (Home/Chat/Context/Extensions/Settings), work shortcuts, account. Main pane **single column**; project cards stack. Sidebar rail **not visible** — drawer only. |
| **Desktop zoom out ~75%** (1440×900, scale 0.75) | Layout boxes **unchanged** (sidebar 270px, editor 720px). Entire UI scales down visually — more peripheral whitespace, denser relative chrome. Share cluster remains visible. No layout reflow. | Same: sidebar 279px, home column 720px at measured boxes. Visual shrink only; **no horizontal scroll**. Input stays **14px** (computed). |
| **Desktop zoom in ~125–150%** (1440×900, scale 1.25) | Layout boxes **unchanged**. No `scrollWidth` overflow. Title `contenteditable` reports **16px** font. Sidebar still pinned; editor column does not widen. | Same stability: no horizontal scroll at 125%. Input remains **14px** — below the 16px iOS input-zoom guard in AGENTS.md if ever shipped to mobile Safari. |

---

## Layout

### Observations (Notion)

**Desktop shell**

- **Left sidebar** (`navigation[name=Sidebar]`): workspace switcher, icon tabs (Home, Chat, Meetings, Inbox), Search, onboarding “Set up your workspace” card, collapsible **Agents** and **Private** sections with `treeitem` page rows, Library / Help / Trash, footer **New chat** (+ compose).
- **Main pane**: page-level top chrome (breadcrumb, Share cluster) then block editor.
- **Editor column**: ~720px wide inside ~1170px content area (1440 − 270 sidebar); `max-width: 100%` on page content — column is effectively **fixed readable width**, not fluid full-bleed.
- **New page affordances**: large placeholder title, “Add icon / cover / comment”, bottom **Get started with** shortcuts, floating **ai** button.

**Mobile shell**

- Sidebar becomes **overlay drawer** (~full viewport width when open); backdrop implied (content obscured).
- **Close sidebar** / **Open menu** toggle; **Lock sidebar open** appears in some states.
- Top bar compacts to menu + page identity + Share; block content uses nearly full width when drawer closed.

**Block editor layout**

- Title as `textbox` (H1-scale).
- Blocks: `checkbox` + paired `textbox` rows with **nested indent** (onboarding checklist); `toggle` block; inline links; `/page`, `/meet` hints styled as inline code.
- Section context menu on sidebar headers (Show N, Move up/down, Hide section, Customize sidebar).

### Transferable rules

1. **Fixed readable column** — primary writing surface caps ~720px; side margins absorb extra desktop width instead of stretching line length.
2. **Sidebar width is constant** — ~270px desktop; mobile reuses the same tree in a drawer, not a simplified alternate IA.
3. **Page chrome vs blocks** — breadcrumb/share live above the editor; blocks never compete with global nav for vertical space.
4. **Empty-state shortcuts** — new pages surface creation pills (AI, database, form) without opening slash menu first.
5. **Mobile = overlay nav, not reflow** — editor goes full width; navigation is interruptive overlay, dismissed on Escape or Close.

---

## Interactions

### Observations (Notion)

**Sidebar drill-down (mobile)**

- **Open menu** → full sidebar overlay with identical structure to desktop (tabs, search, tree).
- Selecting a `treeitem` navigates to page URL; drawer can remain open until explicitly closed.
- **Escape** dismisses section context menus; programmatic **Close sidebar** required when automation cannot click opacity-0 control.

**Block editor**

- Each checklist item is checkbox + editable textbox (dual a11y nodes).
- Toggle block exposes triangle + textbox; nested children indent visually.
- Slash commands referenced in copy (`/`, `/page`, `/meet`) — menu not fully exercised in automation.

**Zoom behavior**

- `pageScaleFactor` 0.75 / 1.25 changes **visual scale only**; `innerWidth`, sidebar width, and editor width (px) stay constant.
- No horizontal scrollbar at 125%; chrome and content scale together.

### Transferable rules

1. **One navigation tree everywhere** — mobile drawer mirrors desktop; don’t maintain two IA variants.
2. **Dismiss overlay explicitly** — menu, sidebar, and section menus respect Escape / close affordance.
3. **Zoom is not a layout breakpoint** — accessibility zoom should scale UI without reflow bugs or sideways scroll.
4. **Block = checkbox + text** pattern for tasks — dual control for hit target and editability.

---

## User flow

### Observations (Notion)

- Land on **Welcome to Notion** onboarding page or **New page** from Private tree.
- Sidebar **Private** section is primary page picker; search parallel path.
- **New chat** footer action (Ctrl+O) sits beside **New page** — chat is peer to docs, not buried in page menu.
- Page URL encodes identity (`Welcome-to-Notion-{id}`); breadcrumb shows page name + Private scope.

### Transferable rules

1. **Tree resume** — last-open page highlighted as `current` treeitem; zero extra “recents” surface needed inside editor.
2. **Parallel create** — new page (compose), new chat, and empty-state pills are distinct entry points.
3. **Scope in breadcrumb** — Private/team visibility beside title, not only in share modal.

---

## Density

### Observations (Notion)

**Sidebar**

- Compact rows: icon + single-line label; section headers with inline + and overflow menus.
- Icon tab row (~40px targets) for Home/Chat/Meetings/Inbox.
- Footer **New chat** full-width pill with shortcut hint.

**Editor**

- Airy title area (large H1, optional icon/cover).
- Checklist rows ~28–32px; nested indent for hierarchy.
- New-page **Get started with** row: horizontal pills at bottom of viewport on desktop; on mobile, fewer pills visible (truncation).

**Chrome vs content**

- Sidebar light gray; editor white; page column centered with wide margins on ultra-wide viewports.

### Transferable rules

1. **Compress nav, breathe in editor** — lists tight; title and first block generous.
2. **720px column** as density anchor — match line length to reading comfort, not viewport width.
3. **Shortcut hints in chrome** — Ctrl+O on New chat, `/` hints in onboarding copy.

---

## Meridian Flow comparison

| Dimension | Notion (observed) | Meridian Flow (observed) | Gap / opportunity |
|-----------|-------------------|-------------------|-------------------|
| **Layout** | Sidebar + centered 720px block editor | Home: sidebar + 720px column; Project: icon rail + card workbench | Adopt **fixed content column** for long-form surfaces (notes, reports). Keep icon rail for workbench; add optional **doc column** when block/markdown editing ships. |
| **Mobile nav** | Overlay drawer = full desktop tree | Overlay drawer = projects + destinations + work shortcuts | Aligned pattern. Add **page/file tree** drill-down when Context/KB tree exists. |
| **Block editor** | Checkbox, toggle, nested blocks, slash hints | Chat composer only; no block model | Deferred — when built, copy Notion’s **720px column + pinned composer/footer** separation. |
| **Zoom** | Uniform scale; no h-scroll at 125% | Uniform scale; no h-scroll; **14px** input | Raise mobile focusable fields to **≥16px** (already in AGENTS.md); verify zoom at 125% on real Safari. |
| **Empty state** | Get started with pills + Ask AI | Hero prompt + package chips | Consider **typed create pills** (analysis, notebook, import) analogous to Notion’s Database/Form row. |

**Already aligned**

- **~720px centered column** on Meridian Flow home matches Notion editor width — good shared reading measure.
- **Mobile hamburger → full nav drawer** — same interruptive overlay pattern.
- **`app-frame` scroll containment** — single scroll owner per pane (see `source-app-shell-patterns.md`); Notion likewise keeps sidebar and editor scroll independent on desktop.

**Not yet present**

- Block/slash editor, nested toggles, or page tree inside project.
- Notion-style breadcrumb + share cluster on document surfaces.
- Sidebar **Agents / Meetings / Chat** tabs as first-class modes (Meridian Flow has Chat/Context routes but not Notion-density tab row).

---

## Blockers

| Blocker | Impact |
|---------|--------|
| Slash (`/`) menu and live block drag not exercisable via accessibility tree | Block-creation and reorder rules inferred from static onboarding page, not live editing |
| Mobile **Close sidebar** often `opacity: 0` in automation | Mobile closed-sidebar observations required programmatic click; manual tap may differ |
| CDP `pageScaleFactor` ≠ OS/browser zoom in all engines | Zoom row validated in Chromium automation; Safari/Firefox may differ slightly |
| Meridian Flow has no block editor in phase-1 | Editor layout comparison is structural (column width, nav), not block-parity |
| Notion marketing / logged-out flows not sampled | Review covers in-app workspace only, per scope |
