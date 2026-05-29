# Navigation

Mode switching, file navigation, tab management, and the complete keyboard
map. Navigation is how the writer moves between contexts without losing their
place.

---

## Mode Switching

The highest-level navigation action. Three modes behind the global mode navigation (Rail on Desktop, BottomNav on Phone — see `foundations/responsive.md`).

| Shortcut | Mode | URL |
|---|---|---|
| `Mod+1` | Agents | `/projects/{id}/agents/...` |
| `Mod+2` | Converse | `/projects/{id}/converse/{threadId}` |
| `Mod+3` | Studio | `/projects/{id}/studio/{documentPath}` |

**Note:** `Mod+1/2/3` is the only group of browser-reserved shortcuts used
in the product. They are interceptable on the web stack with
`preventDefault` and are justified because mode switching is the primary
navigation action and the `Mod+number` convention is the standard (VS Code,
Linear, iA Writer). These are **best-effort** — a small set of browser/OS
configs may still intercept them.

**Behavior:**
- Instant (CSS visibility toggle, no animation)
- All state survives (see `layouts/overview.md` §State Scoping)
- URL updates via TanStack Router `navigate()`
- Focus returns to the last focused element in the target mode
- `aria-live="polite"` announces the mode change for screen readers

> **Decision:** Mode is URL-driven. Bookmarking a Studio URL lands in Studio.
> Bookmarking a Converse URL lands in Converse. Mode is per-user — each user
> lands in their bookmarked mode.
>
> **Rejected:** Mode as app-level state not reflected in URL. This breaks
> bookmarks and browser history, which are standard desktop expectations.

---

## File Navigation

### File Explorer (Studio)

Primary file navigation in Studio mode. See `components.md` §FileExplorer and
`layouts/studio.md` for visual details.

| Action | Result |
|---|---|
| Click file | Open in tab (or activate existing tab) |
| Click folder | Toggle expand/collapse |
| Right-click | Context menu: Rename, Move, Delete, New File, New Folder |
| `Enter` on focused item | Same as click |
| `↑` / `↓` | Navigate tree items |
| `→` | Expand folder or move to first child |
| `←` | Collapse folder or move to parent |
| `Home` | Focus first tree item |
| `End` | Focus last visible tree item |

### Fuzzy File Open (`Mod+P`)

Available in all modes. Opens a lightweight command-palette-style popover
(consistent with the existing cmdk pattern).

| Property | Value |
|---|---|
| Trigger | `Mod+P` (global, with `preventDefault`) |
| Component | `Command` (cmdk) as a popover, not a modal dialog |
| Behavior | Fuzzy match by filename, show path, open in Studio tab |
| Empty state | Recent files (last 10 opened) |
| Keyboard | `↑`/`↓` navigate, `Enter` open, `Escape` close |

When triggered from Converse or Agents, opening a file:
1. Opens the file as a Studio preview tab
2. Does NOT switch to Studio mode (the writer stays in their current mode)
3. In Converse: opens the document in the editor pane as a preview
4. In Agents: tab is created as preview for later

### Breadcrumbs

Breadcrumbs are not a primary navigation pattern in this spec. The rail +
file explorer + fuzzy open provide sufficient navigation for the writer
persona. Breadcrumbs may be added later if the document hierarchy grows deep
enough to warrant them.

---

## Tab Management (Studio)

See `layouts/studio.md` §Tab Bar for visual details.

### Shortcuts

Tab close has no global keystroke in the web build — the browser hijacks all
reasonable close-tab combos. Close via the tab `×` affordance or middle-click.
`Mod+W` appears in the Future Desktop Wrapper appendix only.

| Shortcut | Action |
|---|---|
| `Mod+Shift+Y` | Reopen last closed tab |
| `Mod+Shift+]` | Next tab |
| `Mod+Shift+[` | Previous tab |

### Shortcut Resolution: `Mod+1/2/3`

> **Decision:** `Mod+1/2/3` **always** switch modes (Agents/Converse/Studio),
> globally. There is no tab-by-position shortcut — `Mod+1..9` is reserved by
> the browser for tab switching and is not reliably interceptable.
>
> **Rationale:** Mode switching is the highest-level navigation action and
> owns the most natural shortcuts. Tab navigation uses `Mod+Shift+]`/
> `Mod+Shift+[`, clicking, or `Mod+P`.
>
> **Rejected:** Context-dependent `Mod+1/2/3` (mode switch outside editor,
> tab switch inside editor). Confusing and violates least surprise. Also
> rejected: `Mod+1..9` for tab-by-position — these are not a standard web
> convention and would be undiscoverable.

### Preview Tabs

Documents opened from outside Studio (Converse "Review," fuzzy file open from
other modes) open as **preview tabs** — a single reused slot with an italic
title. The preview promotes to a persistent tab on: edit, hunk action, pin
(double-click or 📌 button), or explicit "Promote to tab." See
`layouts/studio.md` §Tab Bar for the full preview-tab model.

### Tab State Persistence

Open tabs persist to localStorage. Preview tabs are NOT persisted across
page reload. See `layouts/studio.md` §Tab State Persistence for the schema.

### Dirty Tab Close

When closing a tab with unsaved changes:
1. A confirmation dialog appears: "Unsaved changes in [filename]. Save before
   closing?"
2. Actions: "Save" (saves and closes), "Don't Save" (discards and closes),
   "Cancel" (returns to tab)
3. `Mod+Enter` = Save, `Enter` = Don't Save, `Escape` = Cancel

---

## Thread Navigation

### Within Converse

| Shortcut | Action |
|---|---|
| `Mod+/` | Open thread selector dropdown |
| `Mod+Shift+O` | Create new thread |
| `Alt+↑` / `Alt+↓` | Scroll to previous/next turn |
| `Alt+←` / `Alt+→` | Navigate siblings at a branch point |

### Thread Selector

A dropdown in the thread header (Converse) or sidecar header (Studio) that
lists recent threads.

| Property | Value |
|---|---|
| Trigger | Click thread title or `Mod+/` |
| Component | `Command` (cmdk) in a `Popover` |
| Behavior | Fuzzy search thread titles, sorted by recent activity |
| Max visible | 8 threads |
| Keyboard | `↑`/`↓` navigate, `Enter` select, `Escape` close |

---

## Full Keyboard Map

This is the **single canonical shortcut table** for the entire product.
Local shortcut tables in other docs are references back to this section.
Any conflict is resolved by this table.

### `Mod` Convention

> **`Mod` = `Cmd` on macOS, `Ctrl` on Windows/Linux.** This is the
> CodeMirror / ProseMirror convention and the only correct notation for a
> cross-platform web app. Platform-literal combos (`Cmd+…`, `Ctrl+…`) must
> not appear in the canonical table except where a binding is genuinely
> platform-specific, in which case both are listed explicitly.

### Web-Safety Pass

All shortcuts below have been audited against the **reserved-combo
blocklist**. None of the following carry app actions:

- `Mod+N` (new window), `Mod+T` (new tab), `Mod+W` (close tab),
  `Mod+Q` (quit)
- `Mod+Shift+N` (incognito), `Mod+Shift+T` (reopen closed browser tab),
  `Mod+Shift+W` (close window)
- `Mod+Tab`, `Mod+Shift+Tab` (browser/OS tab & app switching)
- `Mod+Shift+Escape` / `Ctrl+Shift+Esc` (Windows Task Manager)
- `Mod+Shift+D` (Chrome bookmark-all-tabs — effectively un-overridable)

Combos that ARE usable but require `event.preventDefault()`:
`Mod+P`, `Mod+F`, `Mod+S`, `Mod+1/2/3` (mode switch — best-effort).

### Shortcut Precedence Rules

When the same keybinding can trigger multiple actions, precedence is:

1. **Editor focus (CM6 has focus)** — formatting and editor commands
2. **Review context (cursor in a hunk)** — hunk actions
3. **Mode-specific context** — panel toggles, thread actions
4. **Global** — mode switching, fuzzy open, settings

Context is determined by focus and cursor position, not by which mode is
active. Example: `Mod+B` in Studio with editor focused = bold; `Mod+B` in
Studio with explorer focused = toggle explorer.

### Canonical Table

#### Global (all modes, all contexts)

| Shortcut | Action | Precedence |
|---|---|---|
| `Mod+1` | Switch to Agents mode | Global (lowest) |
| `Mod+2` | Switch to Converse mode | Global |
| `Mod+3` | Switch to Studio mode | Global |
| `Mod+P` | Fuzzy file open (with `preventDefault`) | Global |
| `Mod+K` | Command palette (future — general command search) | Global |
| `Mod+,` | Open settings | Global |
| `` Mod+` `` | Toggle theme (light/dark/system) | Global |
| `Escape` | Close innermost overlay; stop streaming; exit focus mode | Context-dependent (see below) |

#### Converse Mode

| Shortcut | Action |
|---|---|
| `Mod+Enter` | Send message |
| `Shift+Enter` | New line in composer |
| `Escape` | Stop streaming (if active) |
| `Mod+Shift+E` | Toggle editor pane |
| `Mod+/` | Thread selector |
| `Mod+Shift+O` | New thread |
| `Alt+↑` / `Alt+↓` | Navigate turns |
| `Alt+←` / `Alt+→` | Navigate branch siblings |

#### Studio Mode

| Shortcut | Action |
|---|---|
| `Mod+B` | Toggle file explorer (when editor NOT focused) |
| `Mod+Shift+E` | Toggle chat sidecar |
| `Mod+Shift+G` | Discuss current document (open/scope sidecar thread) |
| `Mod+Shift+\` | Toggle focus mode |
| `Mod+Shift+Y` | Reopen last closed tab |
| `Mod+Shift+]` | Next tab |
| `Mod+Shift+[` | Previous tab |
| `Mod+S` | Save (sync trigger) |
| `Mod+Enter` | Send message (in sidecar composer) |

Tab close has no global keystroke — close via the tab `×` affordance or
middle-click. `Mod+W` appears in the Future Desktop Wrapper appendix only.

**Note:** `Mod+1/2/3` always switches modes globally, never tabs. Tab
navigation uses `Mod+Shift+]` / `Mod+Shift+[`. There is no tab-by-position
shortcut — the combination `Mod+1..9` is reserved by the browser.

#### Editor (within CM6, editor has focus)

| Shortcut | Action |
|---|---|
| `Mod+B` | Bold (when text selected) |
| `Mod+I` | Italic |
| `Mod+E` | Inline code |
| `Mod+K` | Insert link |
| `Mod+Shift+L` | Toggle list |
| `Mod+Shift+Q` | Toggle blockquote |
| `Mod+Z` | Undo |
| `Mod+Shift+Z` | Redo |
| `Mod+F` | In-document search (CM6 built-in) |

**Note:** `Mod+B` in Studio: when editor is focused = bold; when editor is
NOT focused = toggle file explorer. This is a context-dependent shortcut,
and the context is clearly defined by focus.

#### Review (when cursor is inside a hunk decoration)

| Shortcut | Action |
|---|---|
| `Mod+[` | Previous hunk |
| `Mod+]` | Next hunk |
| `Mod+K` (hunk focused) | Keep hunk |
| `Mod+E` (hunk focused) | Edit hunk |
| `Mod+D` (hunk focused) | Discard hunk |

**Note:** `Mod+K` precedence: when editor has focus and cursor is inside a
hunk decoration → Keep hunk. When editor has focus and cursor is NOT in a
hunk → Insert link. Otherwise (editor not focused) → global command palette.

#### Agents Mode

| Shortcut | Action |
|---|---|
| `↑` / `↓` | Navigate thread family cards |
| `Enter` | Select card, show in detail pane |
| `→` | Enter thread tree (branches/spawns) |
| `←` | Back to card level |
| `Mod+Enter` | Open selected thread in Converse |
| `Mod+Shift+O` | New thread in session |

#### Focus Mode (when active)

| Shortcut | Action |
|---|---|
| `Mod+Shift+\` | Toggle focus mode on/off |
| `Escape` | Exit focus mode (return to prior layout) |

### `Escape` Precedence

The `Escape` key resolves to the innermost dismissible context:

1. Close the innermost overlay (dialog, popover, dropdown)
2. If streaming → stop generation
3. If in focus mode → exit focus mode
4. If a panel is a toggle overlay → close it
5. Otherwise → no action

---

## Search

### Global Search (Future)

A unified search across all project content — documents, thread messages,
and metadata. Not in this phase's scope. The shortcut `Mod+Shift+F` is
reserved for this future feature; no current action uses it.

### In-Document Search

Standard CM6 search (`Mod+F`). The search UI is CM6's built-in search panel,
styled to match the Meridian theme:
- Background: `card`
- Input: standard `Input` styling
- Match highlight: `accent-fill` at 20% opacity
- Active match: `accent-fill` at 40% opacity
- Result count: `text-xs`, `muted-foreground`

---

## Touch Gestures

The canonical gesture vocabulary for Phone and Tablet. Every gesture has a
visible button fallback — no gesture is the only way to perform an action.

> **Decision:** One canonical, discoverable gesture set. Every gesture
> requires a visible fallback (button, menu item, or sheet action).
>
> **Rationale:** Gestures are efficient for power users but invisible to new
> users. The strongest mobile exemplars (Google Docs, Linear, Apple's HIG)
> treat gestures as shortcuts for already-visible actions, not as primary
> controls. For a writing tool where accidental actions can modify prose,
> gesture-only controls are unacceptable.
>
> **Rejected:** Gesture-only interactions (undiscoverable). Disabling all
> gestures (unnecessarily restricts power users).
>
> *Evidence: mobile-chat-review.md §5 — "every gesture needs a visible
> affordance"; mobile-responsive-shell.md §4 recommends preserving state
> via explicit controls, not hidden gestures.*

### Canonical Gesture Table

| Gesture | Context | Action | Visible fallback |
|---|---|---|---|
| **Tap** | BottomNav tab | Switch mode | — (tap IS the primary affordance) |
| **Tap** | Highlighted hunk in editor | Open HunkReviewSheet | Hunk highlight is the affordance |
| **Tap** | Tool group header | Expand/collapse | Caret icon in header |
| **Tap** | Wiki-link | Navigate to linked document | Link text styling |
| **Long-press** | Wiki-link | Show preview + Create action | — |
| **Long-press** | Tab (Studio) | Open tab context sheet | — |
| **Long-press** | File-tree item (FileExplorer) | Open item context sheet | Kebab/overflow button on row |
| **Long-press** | Work-item card (Agents) | Open card context sheet | Kebab button on card |
| **Long-press** | Document title (Converse editor) | Pin to Studio | Pin button (on desktop/tablet) |
| **Swipe down** | Bottom sheet | Dismiss sheet | Close button in sheet header |
| **Swipe from left edge** | Studio (Phone) | Open FileExplorer drawer | Hamburger icon in header |
| **Swipe right on hunk** | HunkReviewSheet | Keep hunk | Keep button in sticky bar |
| **Swipe left on hunk** | HunkReviewSheet | Discard hunk | Discard button in sticky bar |
| **Swipe left/right** | Branch turn (SiblingNav) | Navigate siblings | ← / → buttons |
| **Pull down** | Card/thread lists | Refresh | — (standard list convention) |

### Gestures NOT Used

The following gestures are explicitly avoided:

| Gesture | Why not |
|---|---|
| **Edge swipe from right** | Conflicts with iOS/Android system back gesture |
| **Multi-finger gestures** | Undiscoverable, interfere with system gestures |
| **Swipe to delete** on primary content | Too destructive for prose; writing content is never deleted by gesture |
| **Pinch to zoom** on editor | Let the browser handle zoom natively; do not intercept |
| **Force touch / 3D touch** | Deprecated on iOS, not available on Android |

### Discoverability

- **First-time tooltips:** The first time a swipe gesture is available
  (e.g., swipe on a hunk in the review sheet), show a one-time tooltip:
  "Swipe right to keep." Dismissed on tap or after the first successful
  swipe. Stored in localStorage (`meridian:gesture-hints-shown`).
- **Visual affordances:** Grabbers on bottom sheets. Caret icons on
  expandable groups. Arrow buttons alongside swipeable content. Drawer
  handles on drawer edges.

### Keyboard Map Scope on Mobile

The canonical keyboard map in §Full Keyboard Map applies to **Desktop and
Tablet with hardware keyboard.** On Phone (no hardware keyboard), all
actions have touch equivalents:

| Desktop shortcut | Phone equivalent |
|---|---|
| `Mod+1/2/3` | BottomNav tab tap |
| `Mod+P` | Search icon in editor/explorer header |
| `Mod+B` | Hamburger icon / edge swipe (FileExplorer) |
| `Mod+Shift+E` | Chat icon / bottom sheet trigger |
| `Mod+Enter` | Send button tap |
| `Escape` (stop streaming) | Stop button tap |
| `Mod+K/E/D` (hunk actions) | HunkReviewSheet buttons / AccessoryBar buttons |
| Formatting shortcuts | AccessoryBar actions |

---

## Navigation Principles

1. **The writer should always know where they are.** The rail active indicator,
   the tab bar active tab, and the thread title collectively answer "what mode
   am I in, what document am I editing, what thread am I in."

2. **Every navigation action is reversible.** Mode switches don't destroy
   state. Tab closes are undoable (`Mod+Shift+Y`). Thread switches preserve
   the previous thread's state.

3. **Keyboard, mouse, and touch are peers.** Every action available by mouse
   is also available by keyboard (desktop) and by touch (mobile). Power
   users will use keyboard exclusively on desktop; mobile users have touch
   equivalents for every keyboard shortcut.

4. **No navigation modals on desktop.** The fuzzy file open and thread
   selector are lightweight popovers, not full-screen modals. They close
   instantly on `Escape` and don't block the underlying UI. **On Phone,**
   these become full-screen search views or bottom sheets — the phone
   screen is the modal.

5. **Mode switching is instant and accessible.** Mode shells remain mounted
   but inactive shells are removed from the accessibility tree
   (`display:none` + `aria-hidden="true"` + `inert`). Focus is explicitly
   restored on mode switch. See `layouts/overview.md` §CSS Mounting Strategy.

---

## Appendix: Future Desktop Wrapper Keymap

If Meridian ships a desktop wrapper (Electron/Tauri) in a future phase,
many `Mod`-prefixed shortcuts that are currently blocked by the browser
become available natively as `Cmd`/`Ctrl`. This appendix is
**non-normative** — it documents the ideal desktop-native keymap for future
reference only.

### Desktop-native replacements

Where the desktop wrapper can claim the natural OS-native combo:

| Web build | Desktop wrapper | Action |
|---|---|---|
| (no keystroke — affordance only) | `Mod+W` | Close active tab |
| `Mod+Shift+Y` | `Mod+Shift+T` | Reopen last closed tab |
| `Mod+Shift+]` / `Mod+Shift+[` | `Mod+Tab` / `Mod+Shift+Tab` | Next / previous tab |

### Modifier-only swaps

These web-build combos work as-is; the desktop wrapper simply uses the same
`Mod` key (native `Cmd` on macOS, `Ctrl` on Windows/Linux):

| Shortcut | Action |
|---|---|
| `Mod+B` | Toggle file explorer |
| `Mod+Shift+E` | Toggle sidecar/editor pane |
| `Mod+Shift+O` | New thread |
| `Mod+Shift+\` | Toggle focus mode |
| `Mod+/` | Thread selector |
| `Mod+,` | Open settings |
| `` Mod+` `` | Toggle theme |
| `Mod+E` | Inline code (editor) |
| `Mod+K` | Insert link / Keep hunk / Command palette (context) |
| `Mod+Shift+L` | Toggle list (editor) |
| `Mod+Shift+Q` | Toggle blockquote (editor) |
| `Mod+[` / `Mod+]` | Previous/next hunk |
| `Mod+D` | Discard hunk |
| `Mod+Shift+G` | Discuss current document |

**Global mode switch (`Mod+1/2/3`) and file open (`Mod+P` with
`preventDefault`) remain unchanged.** The desktop wrapper uses the same
bindings natively.

In a desktop wrapper, the precedence rules in §Full Keyboard Map still apply.
