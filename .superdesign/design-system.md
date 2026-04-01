# Meridian Design System

## Product Context
Meridian is an agentic writing platform for fiction writers managing 100+ chapter web serials. It provides three workspace modes: Studio (editor-primary), Converse (chat-primary), and Agents (orchestration). The positioning is "serious creative tool" — not playful, not corporate. The paper aesthetic is the key market differentiator.

## Brand Philosophy
- Writer-first: every UI element supports the writing process
- Paper aesthetic differentiator — warm, tactile, literary feel
- Serious creative tool positioning
- Cultivation/xianxia origin is an Easter egg, not marketing

## Color Palette

### Light Mode (default)
- **Background (Paper):** `#F6F2EA` — warm cream/parchment, the signature color
- **Text (Near-black):** `#1F1A12` — warm dark brown, not pure black
- **Primary accent (Jade-Teal):** `#1A8B7A` — for icons, borders, fills (NOT body text — fails WCAG AA)
- **Accent text variant:** Darker teal variant for any text usage (must pass 4.5:1 on paper)
- **Rail/sidebar background:** Slightly darker than paper, subtle distinction
- **Card background:** White or very slightly lighter than paper
- **Border:** Warm gray, subtle, `rgba(31, 26, 18, 0.12)` feel
- **Muted text:** `#6B6358` — warm mid-gray for secondary text
- **Links:** Browser default blue

### Dark Mode
- **Background (Espresso):** `#1C1917` — warm dark brown, not cold black
- **Text (Warm cream):** `#F0EBE3` — matches light mode paper warmth
- **Primary accent (Bright Teal):** `#40C8B0` — brighter for dark bg visibility
- **Rail/sidebar background:** Slightly lighter than espresso `#262220`
- **Card background:** `#252220` warm dark card
- **Border:** `rgba(240, 235, 227, 0.10)` — cream at low opacity
- **Muted text:** Warm mid-tone `#9B9489`

### Semantic Colors (fixed across themes)
- **Accept/Success:** Green
- **Reject/Error:** Red
- **Pending/Warning:** Amber
- **Destructive:** Red accent

### WCAG Contrast Notes
| Pairing | Ratio | WCAG AA |
|---------|-------|---------|
| Near-black `#1F1A12` on Paper `#F6F2EA` | 15.48:1 | Pass |
| Warm cream `#F0EBE3` on Espresso `#1C1917` | 14.74:1 | Pass |
| Teal `#1A8B7A` on Paper `#F6F2EA` | 3.75:1 | FAIL for text |
| **Accent text usage must use darker teal variant** | >=4.5:1 | Required |

## Typography

### Font Families
- **UI font:** `Geist Variable`, sans-serif — clean, modern, technical
- **Editor font:** `iA Writer Quattro` — monospaced-proportional, optimized for long-form prose, 68ch column width
- **Code font:** `Geist Mono` — for inline code and code blocks

### Type Scale (fluid with clamp())
- Body: 14-16px, line-height 1.5-1.6
- Small/Caption: 12-13px
- Heading 1: 24-30px, font-weight 600
- Heading 2: 20-24px, font-weight 600
- Heading 3: 16-18px, font-weight 500
- UI labels: 13-14px, font-weight 500
- Tab labels: 13px
- Rail tooltips: 12px

### Editor Typography
- Font: iA Writer Quattro
- Column width: 68ch (iA Writer standard)
- Line height: 1.6-1.7 for comfortable reading
- Paragraph spacing: 1em

## Spacing System
- 8pt grid base
- Common spacings: 4px, 8px, 12px, 16px, 24px, 32px, 48px
- Component padding: 8px (compact), 12px (default), 16px (relaxed)
- Section gaps: 16px, 24px, 32px

## Icons
- **Library:** Phosphor Icons (6 weights, good writing/creative coverage)
- **Size:** 24px in rail, 20px in toolbars, 16px inline
- **Weight:** Regular weight default, Bold for active states
- **Rail icons:** 24px, centered in 48px rail
- **Key icons:**
  - Agents mode: `Users` or `UsersThree`
  - Converse mode: `ChatTeardrop` or `ChatCircle`
  - Studio mode: `PencilLine` or `Notebook`
  - File explorer folders: `FolderOpen` / `Folder`
  - Documents: `File` / `FileText`
  - Close tab: `X`
  - Unsaved indicator: filled circle dot
  - Connection status: `WifiHigh` / `WifiSlash`

## Layout Architecture

### Rail (shared across all modes)
- Width: 48px fixed
- Position: left edge, full height
- Background: slightly distinct from main bg
- 3 mode icons stacked vertically, centered
- Active mode: teal accent indicator (left bar or icon fill)
- Hover: subtle bg change + tooltip
- Bottom: settings gear icon

### Studio Mode (editor-primary, >=1200px)
```
┌────────────────────────────────────────────────────────┐
│ Rail │ Explorer │  Tab Bar                    │  Chat   │
│ 48px │ ~200px   │  ──────────────────────── │  ~40%   │
│      │          │  Editor Content             │         │
│ [A]  │ folders/ │  (primary, ~60%)            │  msgs   │
│ [C]  │ files    │                             │         │
│ [S]  │          │                             │  comp   │
│      │          │                             │         │
│ ⚙    │          │                             │         │
├──────┴──────────┴─────────────────────────────┴─────────┤
│ Status Bar                                              │
└─────────────────────────────────────────────────────────┘
```

### Converse Mode (chat-primary, >=1200px)
```
┌────────────────────────────────────────────────────────┐
│ Rail │  Thread (primary, ~55%)  │  Editor (~45%)       │
│ 48px │                          │  (collapsible)       │
│      │  message list            │  document content    │
│ [A]  │                          │                      │
│ [C]  │                          │                      │
│ [S]  │                          │                      │
│      │  ┌────────────────────┐  │                      │
│ ⚙    │  │ composer           │  │                      │
│      │  └────────────────────┘  │                      │
├──────┴──────────────────────────┴──────────────────────┤
│ Status Bar                                              │
└─────────────────────────────────────────────────────────┘
```

### Agents Mode (orchestration, >=1200px)
```
┌────────────────────────────────────────────────────────┐
│ Rail │  Work Dashboard           │  Thread Detail       │
│ 48px │  (primary)                │  (secondary)         │
│      │  work item cards          │  selected thread     │
│ [A]  │  with status badges       │  messages            │
│ [C]  │  and thread counts        │                      │
│ [S]  │                           │                      │
│      │                           │                      │
│ ⚙    │                           │                      │
├──────┴───────────────────────────┴─────────────────────┤
│ Status Bar                                              │
└─────────────────────────────────────────────────────────┘
```

### Responsive Tiers
| Tier | Width | Behavior |
|------|-------|----------|
| Expanded | >=1200px | Full multi-pane layout |
| Medium | 840-1199px | One secondary pane at a time, toggles |
| Compact | <=839px | Single primary pane, drawers for secondary |

## Component Patterns

### Tab Bar
- Height: ~36px
- Active tab: distinct bg (slightly lighter/darker), bottom accent border in teal
- Inactive tabs: muted text, transparent bg
- Dirty indicator: small filled dot (teal or warm) before filename
- Close button: small X, appears on hover
- Overflow: horizontal scroll + dropdown chevron at right edge
- Font: 13px Geist, medium weight

### File Explorer
- Width: ~200px default, min 150px, max 300px
- Tree indentation: 16px per level
- Folder icons: Phosphor FolderOpen/Folder
- File icons: Phosphor FileText
- Active file: highlighted row with subtle teal accent
- Hover: subtle bg change
- Font: 13px Geist

### Chat Messages
- User messages: right-aligned or full-width with subtle user bg
- AI messages: left-aligned or full-width with slightly different bg
- Tool call blocks: collapsible, monospace, muted bg
- Timestamps: small, muted
- Font: 14px Geist for UI, prose content in body font

### Panel Resize Handles
- Width: 4px hover zone (1px visible line)
- Hover: visible line thickens or tints teal
- Cursor: `col-resize`
- Double-click: reset to defaults

### Status Bar
- Height: 24-28px
- Position: bottom, full width
- Background: slightly distinct from main bg
- Content: connection indicator (left), credit balance (right)
- Font: 12px Geist, muted color

## Animation & Motion
- Mode switch: instant (CSS visibility, no transition)
- Panel resize: real-time, no transition
- Collapse/expand: 200ms ease-out
- Hover states: 150ms transition
- Toast notifications: slide in from top-right, 200ms

## Interaction Patterns
- 44px minimum touch targets on all interactive elements
- No hover-only interactions — every :hover has a non-hover equivalent
- Pointer Events for unified mouse/touch/pen input
- Focus-visible ring: 3px, ring color from design tokens

## Dark/Light Mode
- Toggle mechanism: class-based (`.dark` on root)
- Transition: 200ms color transitions on bg, text, border
- All colors defined as CSS variables, swapped by class
- No images change between modes — only colors
