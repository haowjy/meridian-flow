# Figma — live product review

Live browser sampling of **figma.com only** (Home file browser + Design editor UI3), across a required viewport and zoom matrix. Compared structurally to Meridian Flow at `https://phase-1.app.meridian.localhost/` (portless, phase-1 worktree). Patterns only — not a visual clone.

**Sources observed**

| Surface | URL / state |
|---------|-------------|
| Figma file browser | `figma.com/files/team/.../recents-and-sharing` |
| Figma Design editor | `figma.com/design/.../AiWikiGen` (UI3, expanded + minimized) |

**Method**

- Viewports set via CDP `Emulation.setDeviceMetricsOverride` (1280×800 desktop, 390×844 mobile).
- Browser/page zoom via CDP `Emulation.setPageScaleFactor` (0.75, 1.25, 1.5) — equivalent to Chrome zoom on the whole page.
- Canvas zoom read from the **percentage button** in right-sidebar chrome (e.g. `9%`, `17%`, `100%`) — Figma-internal, not browser zoom.

---

## Canvas zoom vs browser zoom

Figma maintains **two independent zoom systems**:

| Zoom type | Control | What scales | Observed behavior |
|-----------|---------|-------------|-------------------|
| **Canvas zoom** | Right-sidebar `%` button; scroll-wheel on canvas; zoom menu in Help/zoom toolbar | Artboard plane only (WebGL) | Readout stayed at `9%`–`100%` while browser zoom changed; canvas fit adjusts to show more/fewer frames without resizing chrome |
| **Browser/page zoom** | Browser Ctrl/Cmd ± or `setPageScaleFactor` | Entire DOM — sidebars, tool rail, canvas, text | At 75%: smaller chrome, more canvas pixels visible; at 125–150%: larger touch targets but sidebars consume more of 1280px width; canvas % readout unchanged |

**Transferable rule:** Spatial viewers (volume data, plots) should expose **content zoom** separate from OS/browser zoom — match Figma’s pattern of a persistent canvas-% control that does not fight accessibility zoom.

---

## Viewport & zoom matrix

| Dimension | File browser (Home) | Design editor (UI3) | Tool rail | Left panel | Right panel | Canvas zoom readout | vs Meridian Flow portless |
|-----------|---------------------|---------------------|-----------|------------|-------------|---------------------|-------------------|
| **1. Desktop ~1280px+** (browser 100%) | Fixed ~240px sidebar + responsive thumbnail grid; Create split + AI prompt bar; filter tabs | Full three-column workbench: left structure (Pages/Layers + resize handles), center gray canvas, right inspector (Design/Prototype, Variables, Export); bottom floating tool rail | Centered bottom pill — Move, Frame, Shape, Pen, Text, Comment, Draw/Design/Dev segment; icon-only ~40px targets | ~240px, sectioned Pages + Layers, draggable split | ~240px, selection/page-scoped sections, width resize handle | `9%`–`100%` in right chrome (session-dependent fit) | Meridian Flow: `app-frame` + slim **left icon rail** + single chat column; no right inspector or bottom tool rail yet |
| **2. Mobile ~390px** (browser 100%) | **Graceful:** sidebar → hamburger (“Show navigation”); single-column card grid; filter pills wrap; Community hidden; Help FAB | **Degrades unless minimized:** expanded panels squeeze canvas to a vertical sliver — unusable for editing. **Minimize UI** (auto or manual) → floating top bar (file, Share, canvas `%`) + bottom tool rail; “Expand UI” restores panels | **Resilient:** rail stays centered and fully tappable at 390px in minimized mode; clips/overlaps in expanded mode | Hidden in minimized mode; expanded mode steals ~60% width | Hidden in minimized mode; expanded mode overlaps canvas | Still visible in minimized top chrome (`100%`) | Meridian Flow: keeps one `app-frame` on mobile (`TopBar` + `app-scroll`); rail icons persist; no three-panel squeeze — chat column stacks vertically |
| **3. Desktop zoom out ~75%** (1280px viewport) | Sidebar labels slightly smaller; grid fits more cards per row; AI prompt still full width | All chrome scales down uniformly; three columns remain; more canvas area in pixels; **canvas % unchanged** (observed `17%` at 75% browser vs `9%` at 100% — fit logic, not browser zoom) | Pill shrinks proportionally; flyout shortcuts still readable | Resize handles remain; list rows denser visually | Inspector fields smaller but functional | Independent of browser zoom | Meridian Flow: no special browser-zoom handling; `rem`/token scaling follows browser zoom; layout breakpoints unchanged |
| **4. Desktop zoom in ~125–150%** (1280px viewport) | Sidebar + grid scale up; fewer cards per row; text remains crisp | Panels **do not auto-collapse** — left + right sidebars eat canvas width faster than at 100%; tool rail grows; **no minimize trigger from browser zoom alone** | Larger icons; may approach viewport bottom edge sooner | Wider minimum footprint | Wider minimum footprint | Readout stable (`100%` observed at 150% browser) | Meridian Flow: composer + rail scale with browser zoom; `16px` min input size prevents iOS auto-zoom (separate concern) |

---

## Summary

Figma runs two distinct shells: a **file browser** (sidebar + thumbnail grid) and a **canvas workbench** (left structure panel, infinite center canvas, right inspector, bottom tool rail). UI3 adds **minimize-UI** — sidebars collapse to floating pills so the canvas owns most of the viewport. Creation is multi-path (Create menu, sidebar New file, AI prompt bar, double-click resume). Density is bimodal: airy marketing grid on Home, compact 28–32px list rows and icon-only tool chrome in the editor.

At **mobile width**, the file browser adapts (hamburger nav, stacked cards). The **editor does not reflow** — it blocks practical use unless minimize mode is active. At **browser zoom-in**, Figma does not compensate by collapsing panels; users must manually minimize UI or resize panels.

Meridian Flow (portless, phase-1) is **conversation-first**: low-density home prompt, slim vertical destination rail in-project, single-column chat. The route model anticipates a multi-panel workbench (`?screen=`, docked chat beside Context/KB), but the live UI has not converged on Figma-grade simultaneous panels. The transferable lesson: **separate launcher density from workbench density**, keep tools on a persistent rail, and make **panel collapse a first-class mode** — especially before adding a spatial viewer.

---

## Layout

### Observations

**File browser (desktop 1280px)**

- Fixed **left sidebar** (~240px): account, global search, Recents/Community, team switcher, Drafts/Projects/Trash, Starred folders, upgrade CTA.
- **Main pane**: page title + primary **Create** (split button), optional AI prompt card, filter tabs, sort + org filters, grid/list toggle, responsive **thumbnail cards**.

**File browser (mobile 390px)**

- Sidebar collapses behind **Show navigation** hamburger.
- Single-column large cards; filter dropdowns stack/wrap.
- Community nav item absent from collapsed chrome.

**Design editor (UI3, panels expanded — desktop)**

- **Left sidebar**: File/Assets tabs, Find, collapsible **Pages** + **Layers** with **resize handle** between them.
- **Center canvas**: neutral gray infinite plane; artboards as white frames.
- **Right sidebar**: Design/Prototype tabs, **canvas zoom %**, collapsible Page/Variables/Styles/Export.
- **Bottom tool rail** (`Application toolbar`): floating centered pill.
- **Top chrome**: file breadcrumb, multiplayer/present/share cluster.

**Design editor (UI3, minimized — mobile 390px)**

- Sidebars collapse; **floating pills**: file identity + canvas zoom + Share (top), tool rail (bottom), Help (corner).
- **Expand UI for file named …** restores three-column layout (still cramped at 390px).

### Transferable rules

1. **Two shells, one product** — launcher and workbench are different layout contracts.
2. **Three-column workbench** on desktop — structure left, canvas center, inspector right; tools on a fourth band (bottom rail).
3. **Minimize-UI is a layout mode** — same URL, fewer panels; mandatory escape hatch on narrow viewports.
4. **Mobile file browser ≠ mobile editor** — browser shell is responsive; editor expects minimize or native app.

---

## Interactions

### Observations

**Tool switching**

- Bottom rail buttons show **pressed** state for the active tool (e.g. Move).
- Tool families expose **flyout menus** with **keyboard shortcuts in labels** (Rectangle R, Line L, etc.).

**Zoom / pan**

- **Canvas zoom** surfaced as `%` button in right chrome and Help/zoom toolbar region.
- **Browser zoom** scales chrome and canvas together; canvas % readout does not track browser zoom.
- Pan/zoom on canvas; UI chrome fixed (or floats in minimized mode).

**Panel resize**

- `Resize handle` sliders between Pages/Layers (left) and on right sidebar width.
- At 390px expanded: resize handles present but canvas too narrow to benefit.

**Modes**

- **Design vs Prototype** tabs on the right.
- **Draw / Design / Dev Mode** segment on the tool rail.

### Transferable rules

1. **Active tool always visible** on the rail.
2. **Shortcut hints on controls**, not only in docs.
3. **Inspector follows selection** — page scope when nothing selected.
4. **Collapse panels before shrinking the artifact** — Figma’s minimize mode; Meridian Flow should mirror for spatial screens.

---

## User flow

### Observations

**File browser → editor**

- Recents grid → open card → `/design/{fileKey}/…` — full shell swap.
- **Create** split: Design, FigJam, Slides, Buzz, Site, Make, Import.
- AI prompt bar parallel to manual create.

**Mobile**

- Home: hamburger → sidebar overlay (inferred; button present).
- Editor: must use minimized chrome to reach canvas; inspector requires Expand UI.

### Transferable rules

1. **Resume is visual** — thumbnails + recency on Home.
2. **Open = hard context switch** — launcher → workbench replaces shell.
3. **On mobile web, default to minimized workbench** if three columns cannot fit.

---

## Density

### Observations

| Surface | Desktop 1280px | Mobile 390px |
|---------|----------------|--------------|
| File browser | Airy card grid; compact sidebar rows | Stacked hero cards; hidden sidebar |
| Editor panels | 28–32px layer rows; icon-only rail | Rail icons only in minimized mode |
| Editor expanded | Full inspector fields | Panels overlap — effectively high-density clutter |

### Transferable rules

1. **Bimodal density** — launcher breathes; workbench panels compress.
2. **Icon-first tool rail, text in flyouts**.
3. **Don’t compress the canvas** — collapse chrome first (Figma minimize; Meridian Flow `?screen=` + panel toggles).

---

## Meridian Flow comparison (portless)

| Dimension | Figma (observed) | Meridian Flow phase-1 (observed / source) | Gap |
|-----------|------------------|-------------------------------------|-----|
| **Viewport strategy** | Editor: fixed multi-panel; mobile needs minimize. Home: responsive collapse. | `app-frame` + `h-svh` on all breakpoints; `TopBar` on mobile; one scroll owner (`app-scroll`) | Add **minimize-panels mode** before spatial viewer; don’t rely on browser zoom to save layout |
| **Tool rail** | Bottom floating pill; survives mobile minimized | Left **destination rail** (Home/Chat/Context/Extensions); composer tools in footer | Spatial tools belong on a **persistent rail** separate from nav rail |
| **Panels** | Left structure + right inspector; resize handles | Chat single column; Context/KB routes stubby | Three-zone workbench: structure + viewer + inspector/dock |
| **Zoom** | Canvas % independent of browser zoom | No content zoom yet | Viewer zoom/fit control that doesn’t scale chrome |
| **Mobile** | Editor blocked without minimize; Home OK | Usable chat-first layout; no panel squeeze | Meridian Flow ahead on mobile chat; will need minimize when panels ship |

**Already aligned**

- Vertical rail for destinations (Figma: bottom tools + left nav on Home).
- URL-owned workspace state (`node-id` / `?thread=`).
- Launcher vs workspace route split (Home vs `/design/…`).

**Recommended sequencing**

1. Workbench shell with resizable panels + **minimize mode** (trigger below ~1024px or user toggle).
2. Home low-density; in-project lists at **32px rows**.
3. **Content zoom** on viewers only — not whole-page scale.

---

## Blockers

| Blocker | Impact |
|---------|--------|
| Figma canvas (pan, bbox, WebGL) not exercisable via accessibility tree | Canvas zoom/pan rules inferred from chrome + screenshots, not live manipulation |
| Design editor at 390px with **expanded** panels is effectively blocked | Mobile web editing requires Minimize UI — not obvious to first-time users |
| Browser zoom-in does not auto-collapse panels | At 125–150% on 1280px, canvas area shrinks without mitigation; users must manually minimize |
| Meridian Flow Context/KB and spatial viewers not built in phase-1 | Workbench comparison is structural; portless URL used for rail/chat observations only |
