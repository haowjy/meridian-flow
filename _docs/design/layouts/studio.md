# Studio Mode

Studio answers: **"What am I changing in the workspace right now?"**

The editor is primary. The filesystem tree is the navigation surface.
Chat exists as a collapsible **sidecar** — the assistant in a supporting role.

---

## Layout

```
┌──────────────────────────────────────────────────────┐
│ Rail │ Explorer │  Tab Bar                  │ Sidecar │
│ 48px │ ~200px   │  ──────────────────────── │ ~40%    │
│      │          │  Editor Content            │         │
│ [A]  │ folders/ │  (primary, ~60%)           │  msgs   │
│ [C]  │ files    │                            │         │
│ [S]  │          │                            │  comp   │
│      │          │                            │         │
│ ⚙    │          │                            │         │
├──────┴──────────┴────────────────────────────┴────────┤
│ Status Bar                                             │
└───────────────────────────────────────────────────────┘
```

---

## File Explorer (Left Sidebar)

The primary navigation surface for documents.

| Property | Value |
|---|---|
| Default width | 200px (fixed, not percentage-based) |
| Min width | 150px |
| Max width | 300px |
| Collapsible | Yes — collapses to 0px |
| Background | `--sidebar` |
| Border | 1px `--border` on right edge |
| Toggle | `Mod+B` or click the collapse icon in the explorer header |

### Explorer Header

| Property | Value |
|---|---|
| Height | 36px |
| Background | `--sidebar` |
| Padding | `0 padding-default` |

**Content:**
- "Files" label (`text-xs`, semibold, `muted-foreground`, uppercase,
  `tracking-wider`)
- Flex spacer
- New file button (Phosphor `FilePlus`, `icon-xs`, ghost)
- New folder button (Phosphor `FolderPlus`, `icon-xs`, ghost)
- Collapse button (Phosphor `SidebarSimple`, `icon-xs`, ghost)

### Tree Structure

See `components.md` §FileExplorer for tree item visual treatment.

**Behavior:**
- Single-click file → open in active tab (or create new tab)
- Single-click active file → no-op
- Double-click file → promote preview tab to persistent (or no-op if already persistent)
- Single-click folder → toggle expand/collapse
- Right-click → context menu: Rename, Move, Delete, New File, New Folder
- Long-press a tree item → same actions as context sheet (fallback: visible kebab/overflow button on the row, matching the Studio tab long-press pattern)

### Collapsed State

When collapsed, the explorer is hidden (0 width). The tab bar and editor
expand to fill the space. `Mod+B` or clicking a persistent small toggle icon
at the left edge of the tab bar re-expands it.

---

## Tab Bar

Sits above the editor content area. Manages open documents.

See `components.md` §TabBar for visual treatment.

### Tab Lifecycle

| Action | Behavior |
|---|---|
| Click file in explorer | Open in new tab (or activate existing tab) |
| `Mod+P` → select file | Open in new tab (or activate existing tab; preview if from outside Studio) |
| "Review" from Converse/Agents | Open as preview tab. Promotes on edit/hunk action/pin/double-click |
| Close tab (click X or middle-click) | If dirty, show confirm dialog. Remove tab. No global keystroke in the web build — `Mod+W` is reserved by the browser. |
| Close last tab | Show empty state: "No open documents" + recent files list |
| `Mod+Shift+Y` | Reopen last closed tab |

### Tab Ordering

Tabs are ordered by creation time (left to right). No drag-to-reorder in this
phase. New tabs appear at the right end.

### Tab State Persistence

Open tabs + their order persist to localStorage:

```typescript
interface PersistedTabState {
  tabs: Array<{
    documentId: string
    path: string
    isPreview: boolean  // transient preview, never persisted
  }>
  activeTabId: string
}

// Preview tabs (isPreview: true) are NOT persisted across page reload.
// On reload, only persistent tabs are restored.
```

Scroll positions and cursor positions are held in memory (via `DocSession`)
and survive mode switches but not page reloads. IDB persistence handles
document content.

---

## Editor Area (Primary, ~60%)

The main writing surface. Shows the content of the active tab.

| Property | Value |
|---|---|
| Background | `--background` |
| Padding | `1.5rem 1.75rem` (existing CM6 theme) |
| Content max-width | `--editor-measure` (68ch) |
| Font | iA Writer Quattro at `--editor-font-size` |
| Line-height | `--editor-leading` (1.65) |

### Editor Chrome

Above the editor content:
- **Title header:** Document title (editable), **word count** (document-local
  — the canonical location for word count, NOT the StatusBar), and document
  path. Already built in `editor/title-header/`.

**Note:** Global connection status lives in the StatusBar, not in the editor
chrome. The editor chrome is document-scoped; connection status is app-scoped.

**Note:** When the same document is open in both the Studio editor and the
Converse editor pane, exactly one surface owns the live editable `EditorView`;
the other renders a read-only projection. See `interaction/editor.md`
§Surface Ownership & Mirrored Surfaces for the ownership-transfer contract.

Below the editor content (floating):
- **ProposalReviewToolbar:** Appears when pending hunks exist. Floats at
  bottom-center. See `interaction/proposals-review.md`.
- **Formatting toolbar:** Appears on text selection. See
  `interaction/editor.md`.

### Empty Editor State

When no tabs are open:
- Centered in the editor area
- Phosphor `Notebook` icon, 48px, `muted-foreground`
- "No open documents" heading
- "Open a file from the explorer or press Mod+P" description
- Recent files list (last 5 opened documents)

---

## Chat Sidecar (Secondary, ~40%, Collapsible)

The assistant in a supporting role. Same thread rendering as Converse but in
a narrower pane.

| Property | Value |
|---|---|
| Default width | 40% of available (after rail + explorer) |
| Min width | 300px |
| Collapsible | Yes — collapses to 0px |
| Background | `--background` |
| Border | 1px `--border` on left edge |
| Toggle | `Mod+Shift+E` or click toggle in sidecar header |

### Sidecar Header

| Property | Value |
|---|---|
| Height | 36px |
| Background | `--background` |
| Border | 1px `--border` on bottom |
| Padding | `0 padding-default` |

**Content:**
- Thread title (`text-sm`, medium weight)
- Flex spacer
- "Discuss current document" button (Phosphor `ChatCenteredText`, `icon-xs`,
  ghost, shortcut `Mod+Shift+G`) — opens/scopes a thread to the active
  document
- Thread selector (dropdown, `icon-sm`)
- New thread button (Phosphor `Plus`, `icon-xs`, ghost)
- Collapse button (Phosphor `X`, `icon-xs`, ghost)

### Sidecar Content

Same components as Converse thread pane:
- Turn list (narrower column — no `max-w-3xl` constraint, fills available width
  with `padding-default` horizontal padding)
- Composer at bottom
- `FloatingScrollLayout` for scroll behavior

### Sidecar Collapsed State

When collapsed, the editor area expands to fill the full width (minus
explorer). A small toggle icon at the right edge of the editor chrome area
re-expands the sidecar.

### Sidecar ↔ Document Scoping

> **Decision:** The sidecar thread is **not** automatically scoped to the
> active document. The writer chooses which thread to show via the thread
> selector. This avoids confusing automatic thread switching when changing
> tabs.
>
> **Rationale:** Automatic scoping creates a jarring experience — the sidecar
> conversation changes every time you switch tabs. The writer should be in
> control of which conversation they see.
>
> There is a separate explicit **"Discuss current document"** action
> (button in the sidecar header `Mod+Shift+G`) that opens or switches to a
> thread scoped to the active document's context. This is an opt-in
> convenience, not an automatic behavior.
>
> See `layouts/overview.md` §Cross-Mode Interactions for the full rule.

---

## Panel Resize

Three resizable regions: Explorer | Editor | Sidecar.

| Region boundary | Default | Min | Persistence |
|---|---|---|---|
| Explorer ↔ Editor | Explorer: 200px fixed | Explorer: 150px, Editor: 400px | `meridian:panels:studio` |
| Editor ↔ Sidecar | 60% / 40% | Editor: 400px, Sidecar: 300px | `meridian:panels:studio` |
| Double-click Explorer handle | Reset to 200px | — | — |
| Double-click Sidecar handle | Reset to 60/40 | — | — |

---

## Keyboard Shortcuts

See the canonical keyboard map in `interaction/navigation.md` §Full Keyboard
Map for all shortcuts. Studio-specific shortcuts include:

| Shortcut | Action |
|---|---|
| `Mod+Shift+E` | Toggle chat sidecar |
| `Mod+B` | Toggle file explorer (when editor not focused) |
| `Mod+Shift+G` | Discuss current document (open/scope sidecar thread) |
| `Mod+P` | Quick file open (fuzzy search, with `preventDefault`) |
| `Mod+S` | Save (triggers Yjs sync) |
| `Mod+Enter` | Send message (in sidecar composer) |

**Note:** Tab management uses `Mod+Shift+Y` reopen, `Mod+Shift+]` /
`Mod+Shift+[` cycle. Tab close has no global keystroke — use the tab `×`
affordance or middle-click. `Mod+1/2/3` always switches modes globally,
never tabs. See the canonical map for full precedence rules.

---

## Responsive Behavior

### Tablet Tier (600–1199px)

**Landscape (≥ 900px):**
- Explorer collapses by default. Toggle button at left edge.
- Editor is always visible.
- Sidecar as a toggle overlay (slide-in from right, 40% width). Only one
  secondary (explorer OR sidecar) open at a time.
- Rail visible; drag-resize handles active.

**Portrait (< 900px):**
- Editor full-width with BottomNav.
- Explorer as a left drawer (swipe-from-left-edge or toggle button).
- Sidecar as a bottom sheet (half-height, expandable).
- TabBar visible and scrollable.

### Phone Tier (< 600px)

Editor fills the screen above BottomNav. All secondary surfaces are
overlays:

**FileExplorer on Phone:**
- Left drawer (slide-in from left edge, 85% viewport width).
- Triggered by a hamburger icon (Phosphor `List`) in the editor header,
  or by swiping from the left edge.
- Dismisses on file selection (file opens in editor) or swipe left / tap
  outside.

**TabBar on Phone:**
- Horizontal scroll with no visible scrollbar. Same as desktop but
  narrower — tabs show filename only (no path).
- Tab overflow: a subtle right-edge chevron indicates more tabs. Scrollable
  by horizontal swipe.
- Long-press on a tab opens a context sheet: Close, Close Others, Pin,
  Reopen Closed.

**Sidecar on Phone:**
- Opens as a **bottom sheet** (starts at 50% viewport height, expandable
  to ~90%).
- Triggered by "Discuss" button in the editor header or a dedicated
  chat icon in the BottomNav overflow.
- Contains the same thread rendering as desktop sidecar but in
  full-width layout.
- Composer sits at the bottom of the sheet, above the keyboard when
  typing.
- Dismisses by swipe-down or close button. State preserved.

**"Discuss current document" on Phone:** Same explicit action as desktop
— triggered by a button in the editor header (no keyboard shortcut on
phone). Opens the sidecar bottom sheet scoped to the active document.

**Fuzzy file open on Phone:** `Mod+P` is unavailable on phone (no
physical keyboard). The equivalent is a search icon in the editor header
or FileExplorer header that opens a full-screen search view (same
`Command` component, but full-viewport instead of popover).

---

## Fuzzy File Open (`Mod+P`)

A lightweight command-palette-style popover for quickly opening files by name.
Uses the `Command` (cmdk) component, consistent with the existing command
palette pattern.

| Property | Value |
|---|---|
| Trigger | `Mod+P` (global, with `preventDefault`) |
| Component | `Command` (cmdk) |
| Pattern | Lightweight popover anchored to viewport top-center, not a modal dialog |
| Appearance | `radius-xl`, `--popover` bg, `--elevation-overlay` shadow |
| Width | 500px max |
| Max results | 10 visible, scrollable |

**Behavior:**
- Opens as a popover (top-center of viewport), no backdrop
- Closes instantly on `Escape` or click-outside — does not block the
  underlying UI
- Type to filter files by name (fuzzy match)
- `↑`/`↓` to navigate, `Enter` to open, `Escape` to close
- File paths shown as `text-sm` `muted-foreground` below the filename
- Recently opened files appear at the top when the input is empty
- Match highlights use `accent-text` color

This is consistent with the Navigation Principles rule (see
`interaction/navigation.md`): "The fuzzy file open and thread selector are
lightweight popovers, not full-screen modals."
