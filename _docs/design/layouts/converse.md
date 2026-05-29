# Converse Mode

Converse answers: **"What am I discussing with the assistant right now?"**

Chat is the center canvas. A single active thread fills the primary pane.
The editor is a secondary, collapsible companion for document context.

---

## Layout

```
┌──────────────────────────────────────────────────────┐
│ Rail │  Thread Pane (55%)        │  Editor Pane (45%) │
│ 48px │                           │  (collapsible)     │
│      │  ┌─────────────────────┐  │                    │
│ [A]  │  │   Turn list         │  │  [Tab indicator]   │
│ [C]  │  │   (centered column, │  │  [Editor content]  │
│ [S]  │  │    max-w-3xl)       │  │                    │
│      │  │                     │  │                    │
│      │  │                     │  │                    │
│      │  └─────────────────────┘  │                    │
│      │  ┌─────────────────────┐  │                    │
│ ⚙    │  │ Composer            │  │                    │
│      │  └─────────────────────┘  │                    │
├──────┴───────────────────────────┴────────────────────┤
│ Status Bar                                             │
└───────────────────────────────────────────────────────┘
```

---

## Thread Pane (Primary, 55%)

The center of the Converse experience. A single active thread.

### Thread Header

| Property | Value |
|---|---|
| Height | 44px |
| Background | `--background` |
| Border | 1px `--border` on bottom |
| Padding | `0 padding-relaxed` |

**Content (left to right):**
- Thread title (editable on click, `text-base`, semibold)
- Flex spacer
- Thread selector dropdown (switch between threads without leaving Converse)
- "New Thread" button (Phosphor `Plus`, `icon-sm` button, ghost variant)
- Editor toggle button (Phosphor `SidebarSimple`, shows/hides editor pane)

### Turn List

Renders inside `FloatingScrollLayout`. Turns are rendered in a centered
column (`max-w-3xl`, approximately 768px) with `padding-relaxed` horizontal
padding.

See `interaction/threads-and-tools.md` for the full turn rendering spec.

**Key visual properties:**
- Turn gap: `padding-default` (12px) between turns
- User turn: subtle `muted` background tint (at ~30% opacity), `radius-lg`
- Assistant turn: bare canvas background
- Content font: iA Writer Quattro, `text-base`, line-height 1.6
- `FloatingScrollLayout` provides top/bottom edge fades (28px mask zones)
  and auto-scroll-to-bottom during streaming

### Composer

Positioned at the bottom of the thread pane via `FloatingScrollLayout`'s
bottom slot.

| Property | Value |
|---|---|
| Background | `--card` |
| Border | 1px `--border`, `radius-lg` |
| Margin | `0 padding-relaxed` horizontal, `padding-default` bottom |
| Shadow | `--elevation-subtle` (separates composer from turns above) |

The composer is a CM6 editor (existing implementation) with send/stop controls.
See `components.md` §Composer for the visual spec.

---

## Editor Pane (Secondary, 45%, Collapsible)

The editor provides document context alongside the conversation. It shows the
active document — either the document the current thread references, or the
document last opened via a "Review" action.

### Collapsed State

When collapsed, the editor pane is hidden entirely (0 width). The thread pane
expands to fill 100% of the available width. The thread header's editor toggle
button shows the editor is collapsed (Phosphor `SidebarSimple` with a "show"
indicator).

### Expanded State

| Property | Value |
|---|---|
| Default width | 45% of available (after rail) |
| Min width | 300px |
| Background | `--background` |
| Border | 1px `--border` on left edge |

### Editor Header

| Property | Value |
|---|---|
| Height | 36px |
| Background | `--background` |
| Border | 1px `--border` on bottom |
| Padding | `0 padding-default` |

**Content:**
- Document name (`text-sm`, medium weight); **italic** when showing a
  transient preview, **upright** when showing a promoted/persistent tab
- Pin button (Phosphor `Thumbtack`, `icon-xs`, ghost) — promotes preview to
  persistent tab. Hidden when already promoted.
- Flex spacer
- Collapse button (Phosphor `X`, `icon-sm` button, ghost variant)

**No tab bar in Converse.** The editor shows one document at a time in a
single slot. "Review" actions open documents as transient previews that
promote to persistent Studio tabs on commitment (see below).

### Editor Content

The CM6 editor surface with live preview. Same rendering as Studio but:
- No file explorer
- No tab bar
- Content column still respects `--editor-measure` (68ch)
- Proposal hunks are visible and interactive (same decoration layers)
- `ProposalReviewToolbar` floats at the bottom when pending hunks exist

**Note:** When the same document is open in both the Converse editor pane and
the Studio editor, exactly one surface owns the live editable `EditorView`;
the other renders a read-only projection that updates live from the shared
`Y.Doc`. See `interaction/editor.md` §Surface Ownership & Mirrored Surfaces
for the ownership-transfer contract.

---

## Panel Resize

| Property | Value |
|---|---|
| Default ratio | 55% thread / 45% editor |
| Min thread | 400px |
| Min editor | 300px (when expanded) |
| Double-click handle | Reset to 55/45 |
| Persistence | `meridian:panels:converse` |

---

## Keyboard Shortcuts

See the canonical keyboard map in `interaction/navigation.md` §Full Keyboard
Map for all shortcuts. Converse-specific shortcuts are:

| Shortcut | Action |
|---|---|
| `Mod+Enter` | Send message (in composer) |
| `Shift+Enter` | New line in composer |
| `Escape` | Stop streaming (if active) |
| `Mod+/` | Toggle thread selector |
| `Alt+↑` / `Alt+↓` | Navigate turns |
| `Alt+←` / `Alt+→` | Navigate branch siblings |

---

## Responsive Behavior

### Tablet Tier (600–1199px)

**Landscape (≥ 900px):** Reduced split — Thread 55% / Editor 45%, same as
desktop but smaller minimums (Thread 350px, Editor 250px). Rail is visible.

**Portrait (< 900px):** Thread takes full width with BottomNav. Editor is a
toggle overlay (slide-in from right, 80% width). The thread header's editor
toggle button activates it.

### Phone Tier (< 600px)

Thread takes full width. BottomNav provides mode switching.

**Composer on Phone:**
- Composer anchors above the BottomNav (when keyboard is hidden) or above
  the keyboard (when keyboard is visible), using `visualViewport` positioning.
- Safe-area padding: `env(safe-area-inset-bottom)` added below the composer
  when keyboard is hidden.
- The AccessoryBar (see `components.md`) appears between the composer and
  the keyboard, providing formatting actions.

**Editor on Phone:**
- "Review" opens the document as a **full-screen push** (not a drawer). The
  editor fills the viewport above the BottomNav.
- A back button (Phosphor `ArrowLeft`, 44px) in the editor header returns
  to the thread.
- The AccessoryBar shows hunk-navigation controls (Prev/Next + Keep/Edit/
  Discard) during review. See `interaction/proposals-review.md` §Touch Review.
- Document links in turns also open as full-screen push views.

**Thread selector on Phone:** Opens as a bottom sheet (half-height) instead
of a dropdown, using the `Command` (cmdk) component for fuzzy search.

**Preview→promote on Phone:** The same model applies — documents opened via
"Review" or links are transient previews in Studio's tab state. Promotion
happens on edit, hunk action, or explicit pin (long-press on the document
title in the editor header → "Pin to Studio" action).

---

## Interaction Flows

### "Review" Action from Thread

When an assistant turn produces a proposal and the writer clicks "Review":

1. If the editor pane is collapsed → expand it with `duration-moderate`
   transition.
2. Load the target document in the editor as a **transient preview**
   (italic title). If another preview is already open, it is replaced.
3. Scroll the editor to the first pending hunk.
4. The `ProposalReviewToolbar` appears at the bottom of the editor.
5. The preview **promotes to a persistent Studio tab** when the writer:
   - Edits the document in any way
   - Acts on a hunk (Keep, Edit, or Discard)
   - Clicks the pin button (📌) in the editor header
   - Double-clicks the tab title
   Once promoted, the title becomes upright (no longer italic) and the pin
   button hides.

### Thread Switching

When the writer selects a different thread:

1. `FloatingScrollLayout` triggers its reset cycle: hide content → wait for
   layout stabilization → reveal and scroll to bottom.
2. The editor pane content does not change automatically — it stays on the
   last viewed document. (The writer can manually trigger "Review" to change
   it.)
3. **The target thread's saved composer draft is restored.** Only a newly
   created thread starts with an empty composer.

### Document Link in Turn

When a turn references a document (e.g., a file path in a tool block):

- Clicking the document path opens it in the editor pane (expanding if
  collapsed) as a transient preview.
- The document loads in the same slot — no tab switching.
- The preview promotes to a persistent Studio tab on commitment.
