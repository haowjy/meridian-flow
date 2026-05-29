# Layouts — Overview

The layout system comprises a shared **app shell** and three mode-specific
**layout shells** (Agents, Converse, Studio). The app shell adapts to the
responsive tier: Rail + StatusBar on Desktop, BottomNav on Phone, and a
tier-dependent choice on Tablet (see `foundations/responsive.md`). Mode
switching is the highest-level navigation action a writer takes.

---

## App Shell

The app shell is the outermost frame — always visible, never changes between
modes. Its shape adapts to the responsive tier.

### Desktop Shell (≥ 1200px)

```
┌──────────────────────────────────────────────────────┐
│ Rail │                                                │
│ 48px │         Active Mode Layout Shell               │
│      │                                                │
│ [A]  │   (Agents, Converse, or Studio — one at a     │
│ [C]  │    time, the other two are hidden via CSS)     │
│ [S]  │                                                │
│      │                                                │
│ ⚙    │                                                │
├──────┴────────────────────────────────────────────────┤
│ Status Bar (24px)                                      │
└───────────────────────────────────────────────────────┘
```

### Phone Shell (< 600px)

```
┌───────────────────────────────────────────────────────┐
│                                                        │
│           Active Mode Layout Shell                     │
│                                                        │
│   (single pane — secondary content in drawers/sheets)  │
│                                                        │
│                                                        │
├───────────────────────────────────────────────────────┤
│  [A]        [C]        [S]        [⚙]                  │
│  BottomNav (56px + safe-area-inset-bottom)              │
└───────────────────────────────────────────────────────┘
```

No StatusBar on Phone — connection status folds into the BottomNav or mode
header. Word count remains in the editor chrome (document-scoped).

### Tablet Shell (600–1199px)

Tablet portrait (< 900px): same as Phone shell (BottomNav). Tablet landscape
(≥ 900px): same as Desktop shell (Rail + StatusBar), with reduced multi-pane
layouts. See `foundations/responsive.md` §Tablet Navigation for the rule.

### CSS Mounting Strategy

All three layout shells are **mounted simultaneously** and toggled via CSS.
This means:

- No component unmount/remount on mode switch
- All state (scroll positions, editor content, composer drafts, expanded
  tool groups) survives mode switch automatically
- React effects and subscriptions are governed by the Active/Inactive Work
  Contract below: essential connections and state persist; non-essential work
  pauses while the shell is hidden
- Tab focus returns to the last focused element when switching back to a mode

This is a deliberate tradeoff: slightly higher memory use in exchange for
instant, stateful mode switching.

#### Active/Inactive Work Contract

> **Decision:** Inactive (hidden) mode shells stay mounted, but must **pause all
> non-essential work** while inert. Specifically:
>
> | Keeps running (essential — preserves the stateful-switch guarantee) | Pauses while inactive |
> |---|---|
> | App-level WebSocket connections (`ThreadWsProvider`, `DocWsProvider`) and Yjs sync | Streaming UI animations (token-by-token text, spinners, `RotatingText`) |
> | IndexedDB persistence | `ResizeObserver` / `IntersectionObserver`-driven layout work (e.g. `FloatingScrollLayout` stick-to-bottom, slot measurement) |
> | In-memory state (drafts, scroll, expanded groups, cursor) | `requestAnimationFrame` loops and polling timers |
> | | Auto-scroll-to-bottom reactions to content growth |
>
> When a shell becomes active again, paused work resumes and any deferred
> layout/scroll reconciliation runs once on reveal.
>
> **Rationale:** The all-mounted strategy buys instant, stateful mode switching
> at the cost of higher baseline memory. That tradeoff only stays cheap if
> hidden shells aren't *doing work* — a hidden Converse thread streaming a long
> response, or three shells running `ResizeObserver` reconciliation, would burn
> CPU for UI nobody can see. Connections and state must persist (that's the
> point of staying mounted); rendering and observation must idle.
>
> **Rejected:** Letting all effects run unchanged (current wording) — wastes CPU
> on invisible UI and undermines the memory/perf justification for mounting all
> three shells. Unmounting inactive shells — loses the stateful-switch guarantee
> the whole strategy exists to provide.

#### Inactive Shell Accessibility Rule

> **Decision:** Inactive mode shells remain mounted in React but must be
> removed from the accessibility tree and tab order. The canonical rule is:
>
> 1. The inactive shell container is set to `display: none` (or `hidden` +
>    `aria-hidden="true"`).
> 2. The inactive shell container receives the `inert` attribute (or
>    equivalent — `pointer-events: none` + no tabindex descendants).
> 3. On mode switch, focus is explicitly restored to the last focused
>    element in the newly active mode via `element.focus()`.
>
> **Rationale:** Screen readers and keyboard navigation must not traverse
> invisible UI. `display: none` removes the subtree from the accessibility
> tree; `inert` prevents focus from landing on hidden interactive elements.
> Explicit focus restoration avoids the browser defaulting to `<body>`.

### Layout Grid

**Desktop (Rail):**

```css
.app-shell {
  display: grid;
  grid-template-columns: 48px 1fr;
  grid-template-rows: 1fr 24px;
  height: 100vh;
  width: 100vw;
}
```

The rail occupies column 1. The active mode layout fills column 2. The status
bar spans both columns at the bottom.

**Phone / Tablet portrait (BottomNav):**

```css
.app-shell {
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr auto;
  height: 100dvh; /* dynamic viewport height — see foundations/responsive.md */
  width: 100vw;
}
```

The active mode layout fills row 1. The BottomNav sits at the bottom (row 2),
padded by `env(safe-area-inset-bottom)`. No StatusBar row — connection status
is indicated in the BottomNav area.

---

## Mode Switching

### Mechanism

Mode is a client-side state reflected in the URL.

| Trigger | Tier | Action |
|---|---|---|
| Click rail icon | Desktop, Tablet landscape | Set active mode, push URL |
| Tap BottomNav tab | Phone, Tablet portrait | Set active mode, push URL |
| `Mod+1/2/3` | Desktop/Tablet with keyboard | Set active mode, push URL |
| URL navigation | All | Set active mode from URL segment |

### URL Structure

```
/projects/{id}/agents/...
/projects/{id}/converse/{threadId}
/projects/{id}/studio/{documentPath}
```

> **Decision:** TanStack Router drives mode selection from the URL. Mode is
> the first path segment after the project ID. The router reads the URL on
> load and sets the active mode accordingly.
>
> **Rationale:** URL-driven mode means bookmarks and browser history work
> naturally. A writer who bookmarks a Studio URL lands in Studio when they
> return.
>
> **Implementation note:** Mode switch updates the URL via `router.navigate`
> but does NOT trigger a data fetch — it's a CSS visibility toggle plus a URL
> push. The layout shells are already mounted.

### What Survives Mode Switch

Everything. The CSS-mount strategy means no state is lost.

| State | Survives | Mechanism |
|---|---|---|
| Active thread | ✅ | Thread pane stays mounted |
| Scroll position in thread | ✅ | DOM stays in place |
| Open Studio tabs | ✅ | Tab state stays mounted |
| Editor content/cursor | ✅ | DocSession + EditorView stay alive |
| Composer draft text | ✅ | CM6 state stays mounted |
| Expanded tool groups | ✅ | React state stays mounted |
| WebSocket connections | ✅ | Connections are app-level, not mode-level |
| File explorer expand/collapse | ✅ | Tree state stays mounted |

### What Changes on Mode Switch

| Property | Changes | Details |
|---|---|---|
| URL | ✅ | Reflects new mode |
| CSS visibility of layout shells | ✅ | Only active mode is visible; inactive shells are `display:none` + `aria-hidden` + `inert` |
| Editor chrome (word count, title) | ✅ | Visible per mode (Studio: title header; Converse: editor header) |
| Focus | ✅ | Explicitly restored to last focused element in the new mode |

---

## Responsive Tiers

Three tiers, each with a distinct shell shape and pane model. See
`foundations/responsive.md` for the full tier system, breakpoint detection,
viewport tokens, and safe-area rules.

| Tier | Viewport width | Nav | Pane model |
|---|---|---|---|
| **Phone** | < 600px | BottomNav | Single pane. Secondary content via drawers, bottom sheets, push navigation |
| **Tablet** | 600–1199px | BottomNav (portrait) / Rail (landscape ≥ 900px) | Primary + one toggle overlay or reduced split when width allows |
| **Desktop** | ≥ 1200px | Rail + StatusBar | Full multi-pane, resizable via `react-resizable-panels` |

### Phone Tier (< 600px)

- **Studio:** Editor full-screen. FileExplorer as left drawer. Sidecar as
  bottom sheet. TabBar scrollable with overflow indicator.
- **Converse:** Thread full-screen. Editor as full-screen push. Composer
  anchored above BottomNav + keyboard.
- **Agents:** Dashboard full-screen (scrollable card list). Thread detail
  as push navigation (full-screen with back button).

### Tablet Tier (600–1199px)

Portrait (< 900px): same pane model as Phone (single primary + drawers/sheets).
Landscape (≥ 900px): reduced multi-pane layouts:

- **Studio:** Explorer as a collapsible sidebar. Editor + sidecar in a
  reduced split (sidecar as a toggle overlay if width < 1000px).
- **Converse:** Thread + editor in a reduced split. Thread always visible;
  editor as a toggle overlay at narrower widths.
- **Agents:** Dashboard + detail in a reduced split.

### Desktop Tier (≥ 1200px)

Full multi-pane layouts as specified in the per-mode layout docs. Rail,
StatusBar, resizable panels via drag handles.

### PanelResizeHandle on Touch

> **Decision:** Drag-to-resize handles are a **pointer-only** interaction.
> On Phone and Tablet portrait, panes are full-screen or drawer/sheet —
> there are no drag resize handles. On Tablet landscape and Desktop, drag
> handles work as specified.
>
> **Rationale:** Drag-resizing panes is a precision pointer interaction that
> conflicts with touch scrolling and selection. The mobile form replaces
> resize with layout-mode changes (full-screen swap, drawer, sheet) that
> match mobile interaction conventions.
>
> **Rejected:** Making resize handles touchable with larger hit areas — the
> interaction model on mobile is fundamentally different (discrete layout
> states, not continuous resizing).

---

## State Scoping

State must be scoped correctly to survive mode switches and persist across
sessions where appropriate.

### App-Level State (survives everything)

| State | Storage | Notes |
|---|---|---|
| Active project | URL + memory | Router drives this |
| Theme preference | localStorage (`meridian-theme`) | Light/dark/system |
| WebSocket connections | App-level contexts | `ThreadWsProvider`, `DocWsProvider` |

### Mode-Level State (survives mode switch, per-mode)

| State | Storage | Notes |
|---|---|---|
| Panel sizes per mode | localStorage (`meridian:panels:{mode}`) | Separate keys per mode |
| File explorer collapsed | localStorage | Studio-specific |
| Active Studio tab | memory | Survives switch to Converse and back |
| Converse editor collapsed | memory | Survives switch to Studio and back |

### Session-Level State (per-thread, per-document)

| State | Storage | Notes |
|---|---|---|
| Thread scroll position | memory | Per-thread, survives mode switch |
| Editor scroll position | memory | Per-document (via DocSession). See `interaction/editor.md` §Surface Ownership & Mirrored Surfaces for the one-view-per-document constraint. |
| Editor cursor position | memory | Per-document (via DocSession). Awareness presence follows ownership transfer; see `interaction/editor.md` §Surface Ownership & Mirrored Surfaces. |
| Expanded tool groups | memory (Set in store) | Per-thread |
| Composer draft | memory (CM6 state) | Per-thread |

### Persisted State (survives page reload)

| State | Storage | Notes |
|---|---|---|
| Open tabs + order | localStorage | Tab state with document IDs |
| Active thread ID | localStorage | Last active thread |
| Panel sizes | localStorage | Per-mode |
| Theme | localStorage | — |
| Y.Doc content | IndexedDB | Via y-indexeddb |
| Proposals | IndexedDB | Via proposal-store |

---

## Panel Size Persistence

Each mode stores its panel sizes independently:

| Key | Mode | Stores |
|---|---|---|
| `meridian:panels:studio` | Studio | Explorer width, editor/sidecar ratio |
| `meridian:panels:converse` | Converse | Thread/editor ratio |
| `meridian:panels:agents` | Agents | Dashboard/detail ratio |

`react-resizable-panels` provides `autoSaveId` for this — each mode passes
a unique ID.

---

## Cross-Mode Interactions

### Converse "Review" → Editor

When a "Review" action in Converse targets a document:
1. If the editor pane is collapsed, expand it.
2. Load the document in the editor as a **transient preview** — a single
   reused slot with an italic title. If another preview is already open, it
   is replaced.
3. Scroll to the first pending hunk.
4. The preview **promotes to a persistent Studio tab** on explicit commitment:
   editing the document, acting on a hunk (Keep/Edit/Discard), pinning the
   tab, or double-clicking the tab title.

> **Decision:** Hybrid preview→promote (VS Code preview-tab pattern).
> Transient previews don't clutter Studio, but promotion is effortless.
>
> **Rationale:** The writer shouldn't accumulate dozens of tabs from documents
> they only glanced at. But any interaction that signals intent (edit, review
> action, explicit pin) promotes the tab without friction.
>
> This replaces the earlier decision to always create a real tab.

### Studio "Discuss" → Sidecar

When the writer wants to discuss the current document from Studio, there are
**two distinct paths**:

1. **Existing sidecar thread:** The sidecar thread is **not** automatically
   scoped to the active document. The writer chooses which thread to show via
   the thread selector. Switching tabs does not change the sidecar
   conversation.

2. **"Discuss current document" action:** A deliberate action (button in the
   sidecar header or keyboard shortcut `Mod+Shift+G`) that:
   - Opens or switches the sidecar to a thread scoped to the active document's
     context
   - If no thread exists for this document, creates one
   - This is an explicit opt-in, not automatic

> **Decision:** Default = manual thread selection. "Discuss current document"
> is a separate explicit action.
>
> **Rationale:** Automatic scoping creates a jarring experience — the sidecar
> conversation changes every time you switch tabs. The writer should control
> which conversation they see. The explicit "Discuss" action provides the
> convenience of scoping without the surprise.

### Agents "Open Thread" → Converse

When the writer drills into a specific thread from Agents:
1. Switch to Converse mode.
2. Activate the selected thread.
3. URL updates to `/projects/{id}/converse/{threadId}`.

### Mobile Cross-Mode Behavior

On Phone, cross-mode interactions use push navigation instead of pane
expansion:

- **Converse "Review":** Opens the document as a full-screen editor view
  (push navigation from the thread). The AccessoryBar shows hunk-navigation
  actions. Back gesture/button returns to the thread. The document opens as
  a transient preview in Studio's tab state — same preview→promote model
  as desktop.
- **Studio "Discuss":** Opens the sidecar thread as a bottom sheet
  (half-height, expandable). The writer can swipe down to dismiss or
  expand to full-screen.
- **Agents "Open Thread":** Switches to Converse via BottomNav (same as
  desktop).

State preservation rules are identical to desktop — the mounted-shell
strategy means no state is lost when navigating between modes on mobile.
