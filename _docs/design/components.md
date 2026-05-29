# Components

The component system builds from shadcn/ui atoms through Meridian-specific
composites to layout-level shells. This document covers the atom inventory
(what exists), the composite inventory (what must be built), and the shared
patterns that apply across all components.

---

## Shared Component Patterns

### Visual Rules

1. **Border radius:** `radius-md` (6px) for controls (buttons, inputs, badges).
   `radius-lg` (8px) for containers (cards, panels). `radius-xl` (11px) for
   overlays (dialogs, sheets). Consistent within category; never arbitrary.

2. **Focus-visible:** All interactive elements show a `3px` (`--focus-ring-width`)
   ring in `ring` color at `50%` opacity on `:focus-visible`. No visible ring
   on mouse click — only keyboard navigation.

3. **Touch targets:** Minimum `44px` (`--touch-target-min`) for all interactive
   elements. Where visual size is smaller than 44px (rail icon hit area at
   36×36, tree rows at 28px height, close/pin buttons at 14px), **invisible
   hit-padding** extends the interactive area to 44px without changing the
   visual footprint. This rule applies to all pointer-driven interactions
   (click, hover, drag). Exception: PanelResizeHandle — the 4px visual hit
   area is deliberately narrow for precision; the drag handle is extended by
   an invisible buffer zone to 8px for pointer capture, and keyboard resizing
   (arrow keys) is available as an alternative.

4. **Disabled state:** Reduced opacity (`0.5`), no pointer events, no focus
   ring. `aria-disabled="true"` for ARIA elements, `disabled` for native
   controls.

5. **Loading state:** `aria-busy="true"`. Buttons show inline spinner (existing
   pattern). Other components show `Skeleton` placeholder.

6. **Hover disclosure:** Elements that reveal controls on hover (tab close
   button, panel resize handle tint) must also be accessible via keyboard
   focus or right-click context menu. On Phone and Tablet, hover-only
   controls require a **touch-visible or long-press fallback** (visible
   button, context sheet, or kebab/overflow affordance) — hover is not a
   touch concept.

### Data Slot Convention

All shadcn/ui components include `data-slot` attributes for CLI compatibility
and styling hooks. This convention is already established in the existing 35
components and must continue for all new components.

---

## Enforcement & Consistency Policy

shadcn/ui is deliberately "open code" — it does **not** centralize consistency
the way versioned libraries like MUI or Radix Themes do. That means our repo
must supply the governance. The patterns documented in this spec (tokens, CVA,
`data-slot`, Storybook-first) are the right *mechanisms*, but without explicit
enforcement rules they will drift. This section defines the gates.

*Evidence: research `web-component-consistency.md` — shadcn introduction, DTCG
v2025.10, tailwind-merge guidance, ESLint rules config, Chromatic mandatory PR
checks.*

### Override Policy

> **Decision:** `className` and `twMerge` are **boundary escape hatches** for
> merging consumer or downstream overrides — they are NOT the primary styling
> model. Internal component composition uses `twJoin` or plain string
> concatenation. `twMerge` is called only at the component boundary where a
> consumer's `className` prop merges with the component's own default classes,
> and nowhere else.
>
> **Rationale:** The tailwind-merge docs explicitly warn that treating
> `twMerge` as a blanket override mechanism increases freedom in ways that
> make future refactors harder ([tailwind-merge guidance](https://github.com/dcastil/tailwind-merge/blob/main/docs/when-and-how-to-use-it.md)). Keeping the
> merge surface narrow means the supported styling surface stays explicit and
> searchable. Internal composition does not need conflict resolution — it
> needs predictable concatenation.
>
> **Rejected:** Using `twMerge` everywhere for composition. Creates a
> system where any class string can silently override any other, making it
> impossible to reason about what styles will actually render at any given
> node.

**Supporting rules:**

- Every component that exposes style variants **must** use a canonical variant
  factory (CVA for simple atoms, `tailwind-variants` permitted for slot-heavy
  composites if the extra abstraction pays for itself). The variant map is the
  single source of truth for what styling states exist.
- Ad-hoc `className` overrides outside the variant map are an **explicit
  escape hatch** — not the default path. Use them sparingly and document them.
- `twJoin` (or plain string concat) for internal class composition; `twMerge`
  only where a consumer `className` prop must merge with component defaults.

### No-Orphan-Styles Rule

> **Decision:** If a style pattern appears in more than one place, it must
> graduate into a token, a CVA variant, or a shared composite. One-off
> Tailwind strings in JSX are the primary vector for future refactoring
> brittleness.
>
> **Rationale:** In a shadcn-style open-code system, divergence accumulates
> quickly because there is no library-level authority blocking ad-hoc styles.
> The research on variant management confirms that putting all supported
> styling states in one variant factory keeps the "what styles exist?"
> question answerable in a single file ([CVA README](https://github.com/joe-bell/cva)). Orphan styles
> scattered across JSX make it impossible to change the design system
> confidently.
>
> **Rejected:** Allowing one-off Tailwind strings as the norm. This is how
> most Tailwind projects start, but it does not scale to a design system
> with enforced consistency.

### Lint Contract (CI Gate, `error` Level)

These rules run at `error` level in CI, pre-commit, and PR merge — an ESLint
exit code of non-zero blocks the merge ([ESLint rules config](https://eslint.org/docs/latest/use/configure/rules)).

| Rule | Package | Rationale |
|---|---|---|
| `no-arbitrary-value` | `eslint-plugin-tailwindcss` | Blocks arbitrary values like `w-[17px]` or `text-[#abc]` that bypass the token system ([plugin docs](https://www.npmjs.com/package/eslint-plugin-tailwindcss)) |
| `no-custom-classname` | `eslint-plugin-tailwindcss` | Prevents ad-hoc classname invention outside the token/utility vocabulary |
| No raw hex / raw color values | custom ESLint rule or Stylelint | Color values must reference design tokens; raw `#fff` or `oklch(…)` is only permitted in `foundations/` token-plumbing files |
| Require `data-slot` on shadcn-derived primitives | custom ESLint rule | Every primitive must expose the stable selector hook shadcn v4 relies on for styling ([shadcn Tailwind v4](https://ui.shadcn.com/docs/tailwind-v4)) |
| Require variant factory for styled components | custom ESLint rule (filename or export convention) | Any component that exposes style variants must have a detectable CVA/TV definition |

**Stylelint** supplements ESLint for CSS-level conventions: naming patterns for
custom properties, disallowed units/notations, and enforcement of the token
naming hierarchy ([Stylelint home](https://stylelint.io/index.html)).

### Visual Gate (Chromatic)

> **Decision:** Chromatic (or an equivalent visual-regression platform) is a
> **required PR check** gated by branch protection. A PR with visual diffs
> cannot merge until the diffs are reviewed and approved.
>
> **Rationale:** Static analysis catches class-name and token violations but
> cannot catch rendering drift — a correct token applied in the wrong place
> still produces a correct lint score. Chromatic catches actual pixel changes
> and makes them visible in the PR review workflow ([Chromatic mandatory PR checks](https://docs.chromatic.com/docs/mandatory-pr-checks/)). This is one of
> the strongest enforcement mechanisms available for UI consistency.
>
> **Rejected:** Relying solely on lint + manual review. Even careful reviewers
> miss visual regressions in code diffs, especially across responsive
> breakpoints, dark/light themes, and interaction states.

### Story Coverage Contract

> **Decision:** If a component state is supported, it deserves a Storybook
> story. Stories are the **component contract** in an open-code system — they
> are the canonical surface for visual review, interaction testing, and
> documentation.
>
> **Rationale:** In a shadcn-style code-owned system, there is no upstream
> library version that guarantees behavior. Stories become the shared contract
> for how the local code is supposed to behave ([Storybook docs](https://storybook.js.org/docs/)). Storybook +
> Chromatic creates an enforcement pipeline: every story is a test case, and
> every test case gates the merge ([Chromatic Storybook quickstart](https://www.chromatic.com/docs/storybook)).
>
> **Rejected:** Treating Storybook as optional documentation. Without story
> coverage, there is no mechanical guarantee that a component's supported
> states are visible, testable, or regression-gated.

**Minimum story coverage per component:**

- **Loading state:** Skeleton or spinner placeholder
- **Empty state:** Centered message with icon, heading, description
- **Error state:** Error message with retry action (where applicable)
- **Interaction states:** Hover, focus-visible, active, disabled (where applicable)
- **Every supported variant combination:** One story per variant value + key
  compound variants

The existing 35 atom components already have co-located `.stories.tsx` files.
New composites (Rail, TabBar, BottomNav, BottomSheet, etc.) must follow the
same pattern.

---

## Existing Atom Inventory (35 components)

All built, all have co-located `.stories.tsx` files. Listed by category for
reference — see `grounding/frontend-v2-state.md` §6 for detailed API notes.

### Form Controls

| Component | Primitive | Key variants/features |
|---|---|---|
| **Button** | Radix Slot | `default`, `destructive`, `outline`, `secondary`, `ghost`, `link` × 8 sizes; loading spinner; `asChild` |
| **Input** | native `<input>` | 44px touch target |
| **Textarea** | native `<textarea>` | Auto-grow, character count |
| **Select** | Radix Select | Groups, separators, Phosphor chevrons |
| **Checkbox** | Radix Checkbox | Indeterminate state |
| **Switch** | Radix Switch | Optional label |
| **Toggle** | Radix Toggle | Pressed state |
| **ToggleGroup** | Radix ToggleGroup | Multi/single select |
| **Slider** | Radix Slider | Range input |
| **FormField** | custom | Label + error + helper text |

### Overlays

| Component | Primitive | Key features |
|---|---|---|
| **Dialog** | Radix Dialog | Viewport-aware (bottom sheet on small screens) |
| **Sheet** | Radix Dialog | Side sheets (all 4 directions) |
| **Popover** | Radix Popover | Anchored floating panels |
| **Tooltip** | Radix Tooltip | 4 placements, focus + hover trigger |
| **DropdownMenu** | Radix DropdownMenu | Sub-menus, checkbox/radio items, keyboard shortcuts |
| **ContextMenu** | Radix ContextMenu | Same API as DropdownMenu |
| **Command** | cmdk | Command palette, searchable, grouped |

### Content Display

| Component | Primitive | Key features |
|---|---|---|
| **Card** | native div | Header, Title, Description, Content, Footer slots |
| **Badge** | CVA | `default`, `secondary`, `outline`, `success`, `warning`, `destructive` |
| **Avatar** | Radix Avatar | Image + fallback initials |
| **Accordion** | Radix Accordion | Expandable sections |
| **Tabs** | Radix Tabs | Tab panels |
| **Collapsible** | Radix Collapsible | Show/hide content |
| **Progress** | Radix Progress | Linear progress bar |
| **Skeleton** | native div | Loading placeholder with pulse animation |
| **Separator** | Radix Separator | Horizontal/vertical |
| **ScrollArea** | Radix ScrollArea | Custom scrollbars |
| **Breadcrumb** | native nav | Breadcrumb navigation |
| **TreeView** | Ark UI | Hierarchical tree, indent guides, branch indicators, multi-select |
| **Toast/Sonner** | sonner | Success/error/warning/info, actions, stacking |
| **Alert** | native div | Warning/info/destructive variants |
| **Label** | Radix Label | Internal use by other components |

### App Shell

| Component | Primitive | Key features |
|---|---|---|
| **ThemeToggle** | custom | Phosphor Sun/Moon, light/dark/system cycling |

---

## New Composite Components

These must be built for the layout shells. Each is described at spec level —
enough for implementation, not a code blueprint.

### Rail

The global mode-switching column shared across all modes.

| Property | Value |
|---|---|
| Width | 48px fixed |
| Height | Full viewport |
| Position | Left edge, fixed |
| Background | `--sidebar` |
| Border | 1px `--border` on right edge |

**Content (top to bottom):**

1. **Mode icons** — three stacked, centered horizontally:
   | Mode | Icon | Shortcut |
   |---|---|---|
   | Agents | `UsersThree` | `Mod+1` |
   | Converse | `ChatTeardrop` | `Mod+2` |
   | Studio | `PencilLine` | `Mod+3` |
   - Size: 24px
   - Default weight: Regular
   - Active weight: Bold (but see active indicator below)
   - Spacing: 8px gap between icons
   - Hover: `muted` background on 36px × 36px hit area, `radius-md`, tooltip
     on right with mode name + shortcut
   - Hit area: Visual size is 36×36; invisible hit-padding extends the
     interactive area to 44×44 (the `--touch-target-min`) for pointer events

2. **Active indicator:**
   > **Decision:** Left accent bar (2px width, `accent-fill` color, spanning
   > the icon's 36px hit area height), positioned at the left edge of the rail.
   > The active icon also uses Bold weight.
   >
   > **Rationale:** Left bar is the established convention (VS Code, Linear)
   > and has lower visual weight than a full icon fill. It provides a clear
   > spatial marker without dominating the rail.
   >
   > **Rejected:** Icon fill (teal-tinted icon). Higher visual weight,
   > harder to distinguish from hover state.

3. **Flex spacer** — pushes settings to bottom

4. **Settings icon** — `GearSix`, Regular weight, same hover pattern as mode
   icons. Opens a settings sheet or dropdown.

**Keyboard:** `Mod+1/2/3` switch modes. Rail icons are in the tab order;
`Enter` activates. Keyboard behavior is via `role="tablist"`/`role="tab"`;
arrow keys navigate between mode icons, `Enter`/`Space` activate.

### StatusBar

Global status strip at the bottom of the viewport.

| Property | Value |
|---|---|
| Height | 24px |
| Position | Bottom, full viewport width (including below rail) |
| Background | `--sidebar` |
| Border | 1px `--border` on top edge |
| Font | `text-xs`, `muted-foreground`, Geist |
| Padding | `0 padding-default` |

**Content (left to right):**
- **Connection indicator:** Phosphor `WifiHigh` (connected, `success` tint) or
  `WifiSlash` (disconnected, `destructive` tint), 14px icon + text label.
  This is the **canonical global connection status** — shown in all modes.
- **Flex spacer**
- **Credit balance** (if applicable): right-aligned

**Word count is NOT in the StatusBar.** It lives in the editor chrome
(Studio title header), scoped to the active document. See
`layouts/studio.md` §Editor Chrome.

### TabBar (Studio)

Document tabs for the Studio editor.

| Property | Value |
|---|---|
| Height | 36px |
| Background | `--background` |
| Border | 1px `--border` on bottom |
| Font | `text-sm`, Geist, medium weight |
| Tab padding | `padding-compact` horizontal |

**Tab states:**
| State | Background | Text | Additional |
|---|---|---|---|
| Active (persistent) | `--card` | `--foreground` | 2px `accent-fill` bottom border |
| Active (preview) | `--card` | `--foreground`, *italic* | 2px `accent-fill` bottom border, no dirty dot |
| Inactive (persistent) | transparent | `--muted-foreground` | — |
| Inactive (preview) | transparent | `--muted-foreground`, *italic* | — |
| Hover (inactive) | `--muted` at 50% | `--foreground` | — |
| Dirty | same as active/inactive | same | `accent-fill` dot (6px) before filename |

**Preview tabs:** A single reused slot for documents opened from outside
Studio (e.g., Converse "Review"). Visual distinction: italic title. Promotes
to persistent on edit, hunk action, pin, or double-click. Once promoted, the
title becomes upright. Only one preview slot exists — opening a new preview
replaces the previous one.

**Tab anatomy:** `[dirty dot] [filename.ext]* [close button] [pin button]`
- `*` = italic for preview tabs
- Close button: Phosphor `X`, 14px, visible on hover or when tab is active.
  On Phone/Tablet, tab close is reachable via the long-press tab context
  sheet (desktop hover does not apply on touch).
- Pin button: Phosphor `Thumbtack`, 14px, visible on hover for preview tabs
  only — promotes to persistent tab
- Click: activate tab
- Middle-click: close tab
- Double-click title on preview: promote to persistent
- Close via keyboard: no global keystroke in the web build — use the tab `×` affordance or middle-click. `Mod+W` appears in the Future Desktop Wrapper appendix only.
- Reopen last closed: `Mod+Shift+Y` (see canonical keyboard map)

**Overflow:** Horizontal scroll with no visible scrollbar. Chevron indicator
at right edge when tabs overflow.

### FileExplorer (Studio)

Document/folder tree in Studio's left sidebar.

| Property | Value |
|---|---|
| Default width | 200px |
| Min width | 150px |
| Max width | 300px |
| Background | `--sidebar` |
| Border | 1px `--border` on right edge |
| Font | `text-sm`, Geist |

**Tree item anatomy:**
- Indentation: 16px per level
- Row height: 28px (meets 44px touch target with comfortable click area)
- Hover: `muted` background
- Active file: `accent-fill` at 8% opacity background, `accent-text` text
- Folder icons: Phosphor `FolderOpen` (expanded) / `Folder` (collapsed), 16px
- File icons: Phosphor `FileText`, 16px
- Font weight: 400 normal, 500 medium for active file

**Context menu:** right-click → Rename, Move, Delete, New File, New Folder.
See `interaction/navigation.md` for keyboard shortcuts.

### PanelResizeHandle

Draggable divider between resizable panes.

| Property | Value |
|---|---|
| Hit area | 4px width (invisible), extended to 8px for pointer capture |
| Visible line | 1px `--border` centered in the 4px area |
| Hover | Line becomes 2px, tinted `accent-fill` |
| Active (dragging) | Line remains 2px `accent-fill` |
| Cursor | `col-resize` (or `row-resize` for horizontal) |
| Double-click | Reset pane to default ratio |

**Keyboard resizing:** The handle is focusable via Tab.

| Property | Value |
|---|---|
| Role | `separator` |
| `aria-orientation` | `vertical` (for column resizers) or `horizontal` (for row resizers) |
| `aria-valuenow` | Current pane size in pixels |
| `aria-valuemin` | Minimum pane size |
| `aria-valuemax` | Maximum pane size |
| Arrow keys | Resize by 20px per keypress (respect orientation) |
| `Shift` + arrow keys | Resize by 100px per keypress |
| `Enter` | Reset to default ratio (same as double-click) |
| `Escape` | Cancel resize and return to previous size |

**Default ratios (per mode):**
| Mode | Pane 1 | Pane 2 | Pane 3 |
|---|---|---|---|
| Studio | Explorer 200px (fixed) | Editor 60% | Sidecar 40% |
| Converse | Thread 55% | Editor 45% | — |
| Agents | Dashboard 60% | Detail 40% | — |

### ChatMessage / Turn Components

**Already substantially built** in `features/threads/` and
`features/activity-stream/`. The spec here defines the visual treatment.

See `interaction/threads-and-tools.md` for the full turn rendering spec.

> **Decision:** Full-width messages with subtle role distinction via background
> tint. User turns get a barely-visible `muted` background tint. Assistant
> turns render on the bare canvas.
>
> **Rationale:** Full-width maximizes the reading column and matches the
> editorial, literary feel. Left/right bubble alignment is a chat-app pattern
> that conflicts with the "serious creative tool" positioning and wastes
> horizontal space on a desktop screen.
>
> **Rejected:** Left/right bubble alignment. Reduces effective reading width,
> creates a casual/chat-app feel inconsistent with the literary personality.

### Composer

**Already built** as a CM6 editor in `features/threads/composer/`. The spec
defines the visual frame.

| Property | Value |
|---|---|
| Position | Bottom of thread pane, sticky |
| Background | `--card` |
| Border | 1px `--border`, `radius-lg` |
| Min height | 44px (single line + padding) |
| Max height | 40vh |
| Font | `text-base`, Geist |
| Padding | `padding-default` |

**Controls:**
- Send button: Phosphor `PaperPlaneTilt`, `accent-fill` color, right-aligned
- Stop button: Phosphor `StopCircle`, `destructive` color, replaces send during
  streaming

### WorkItemCard (Agents)

Session/work-item card for the Agents dashboard.

| Property | Value |
|---|---|
| Background | `--card` |
| Border | 1px `--border`, `radius-lg` |
| Padding | `padding-relaxed` |
| Font | Geist |

**Content:**
- **Title:** `text-base`, semibold
- **Status badge:** Badge component with appropriate variant
- **Thread count:** `text-sm`, `muted-foreground`, Phosphor `ChatTeardrop` icon
- **Last activity:** `text-xs`, `muted-foreground`, relative timestamp
- **Active indicator:** Left border 2px `accent-fill` on the active/selected card

See `layouts/agents.md` for the full Agents layout.

### BottomNav

The primary navigation surface on Phone and Tablet portrait. Replaces the
Rail on these tiers.

| Property | Value |
|---|---|
| Height | 56px + `env(safe-area-inset-bottom)` |
| Position | Bottom edge, full viewport width, fixed |
| Background | `--sidebar` |
| Border | 1px `--border` on top edge |

**Content (evenly spaced, centered):**

| Tab | Icon | Label |
|---|---|---|
| Agents | `UsersThree` | "Agents" |
| Converse | `ChatTeardrop` | "Converse" |
| Studio | `PencilLine` | "Studio" |
| More | `DotsThree` | "More" |

- Icon size: 24px, centered above label
- Label: `text-xs`, Geist, `muted-foreground` (inactive), `foreground`
  (active)
- Active tab: icon uses Bold weight, `accent-text` color; label uses
  `accent-text` color
- Active indicator: 2px `accent-fill` horizontal bar above the icon
  (not below — avoids confusion with the safe-area padding)
- Hit area: full tab width × 56px (extends to safe-area edge for the
  bottom tabs)

**"More" tab:** Opens a bottom sheet with secondary actions:
- Settings
- Theme toggle
- Connection status (if disconnected, shows `destructive` indicator on
  the More icon as a small dot)

**ARIA:** `role="tablist"` with `role="tab"` per tab. Same pattern as the
Rail, adapted for bottom placement.

**Keyboard (Tablet with hardware keyboard):** When BottomNav is visible
(Tablet portrait), `Mod+1/2/3` still work for mode switching.

### AccessoryBar

A compact action strip above the virtual keyboard on Phone and Tablet.
Provides contextual formatting and review actions while editing.

| Property | Value |
|---|---|
| Height | 44px |
| Position | Above the virtual keyboard (positioned via `visualViewport` or `navigator.virtualKeyboard`) |
| Background | `--card` |
| Border | 1px `--border` on top |
| Shadow | `--elevation-subtle` |
| Padding | `0 padding-compact`, safe-area left/right in landscape |

**Actions:** 7 icon buttons, evenly spaced. The action set is contextual
— see `interaction/editor.md` §Touch & Mobile Editing for the editing and
review action sets.

| Property | Value |
|---|---|
| Button size | 36px visual, 44px hit area (invisible padding) |
| Icon size | 20px |
| Icon color | `muted-foreground` (inactive), `accent-fill` (active/toggled) |
| Separator | 1px `border` between formatting and overflow groups |

**Positioning logic:**
1. Feature-detect `navigator.virtualKeyboard` (Chromium). If available,
   use `env(keyboard-inset-height)` in CSS.
2. Fallback: listen to `visualViewport.resize` and position the bar at
   `visualViewport.height - accessoryBarHeight`.
3. When the keyboard is not visible, the AccessoryBar is hidden.

**Visibility rule:** Appears only when the CM6 editor has focus AND the
virtual keyboard is visible. Hides when focus leaves the editor or the
keyboard dismisses. On Tablet with a hardware keyboard, the AccessoryBar
is not shown (the floating formatting toolbar serves the same role).

### BottomSheet

The generic reusable bottom-sheet surface. A BottomSheet slides up from the
bottom of the screen and is used on Phone (and Tablet portrait) for detail
views, thread selectors, tool output, hunk review, context sheets, and the
"More" overflow menu. Every BottomSheet shares the same structural shell;
domain-specific sheets (HunkReviewSheet, context sheets, etc.) are
specializations that provide content + action bar slots.

| Property | Value |
|---|---|
| Detents | `0.5` (half-height), `0.9` (full-height) as defaults; customizable per instance |
| Initial detent | Configurable (default `0.5`) |
| Min drag threshold | 40px (drag below threshold snaps back) |
| Background | `--card` |
| Border-radius | `radius-xl` on top corners |
| Shadow | `--elevation-overlay` |
| Swipe-down | Dismiss (below velocity threshold or past 40% of detent) |
| Backdrop | Semi-transparent `--foreground` at 10% opacity. Tapping the backdrop dismisses the sheet. |
| Safe-area | Bottom padding = `env(safe-area-inset-bottom)` on the action bar |

**Structural slots:**

1. **Grabber bar:** 40px × 4px centered horizontal bar, `muted` color, `radius-full`. Always present; the visual affordance that signals draggability.
2. **Header:** Title (`text-base`, semibold), optional subtitle, close button (Phosphor `X`, 44px hit area). Close button can be hidden if swipe-down is the primary dismiss path.
3. **Content:** Scrollable body region. Fills available height between header and action bar.
4. **Sticky action bar (optional):** Full-width row at the bottom, `padding-default` horizontal, padded by `env(safe-area-inset-bottom)`. Shown only when the sheet needs bottom action buttons (Keep/Edit/Discard, context actions, etc.).

> **Decision:** One generic BottomSheet component with structural slots.
> Domain-specific sheets (HunkReviewSheet, context sheets, "More" overflow)
> are specializations that provide content and action-bar children.
>
> **Rationale:** A single shared surface reduces duplication of detent
> logic, drag-to-dismiss, safe-area padding, and backdrop behavior. Each
> specialization only needs to supply content and optional action buttons.
>
> **Rejected:** Per-use-case bottom-sheet implementations — duplicates
> accessibility, gesture, and safe-area logic across multiple components.

### HunkReviewSheet

A **specialization of BottomSheet** for per-hunk proposal review on touch
devices. Inherits the generic detents, drag-to-dismiss, grabber, and
safe-area behavior from BottomSheet. See `interaction/proposals-review.md`
§Touch Review for the full interaction model.

| Property | Value |
|---|---|
| Content area (scrollable) | Inherits BottomSheet content slot |
| Detents | Inherits BottomSheet detents (`0.5` / `0.9`) |

**Header:**
- Hunk counter: "2 of 5" (`text-sm`, `muted-foreground`)
- Prev/Next buttons: Phosphor `CaretLeft`/`CaretRight`, 44px hit area
- Close button: Phosphor `X`, 44px hit area

**Content area (scrollable):**
- Changed text in context with surrounding prose
- Provenance label
- Optional explanation

**Sticky action bar (bottom) — specialized for review:**
- Keep / Edit / Discard buttons, 44px height
- Full-width row, `padding-default` horizontal
- Padded by `env(safe-area-inset-bottom)` (plus the BottomSheet base safe-area padding)

### MobileComposer

The Composer component on Phone, adapted for thumb-reach and keyboard
interaction.

| Property | Value |
|---|---|
| Position | Above BottomNav (keyboard hidden) or above keyboard (keyboard visible) |
| Background | `--card` |
| Border | 1px `--border`, `radius-lg` on top corners only |
| Shadow | `--elevation-subtle` |
| Min height | 44px |
| Max height | 40vh (same as desktop) |
| Safe-area | `env(safe-area-inset-bottom)` when above BottomNav |

**Send/Stop button:** Same toggle behavior as desktop but larger — 44px
circle, right-aligned inside the composer. See
`interaction/threads-and-tools.md` §Mobile Chat Surface for the send/stop
toggle rule.

**Attach/voice controls:** Left of the text input, 44px hit areas.

---

## Existing Component Responsive Notes

### Rail (responsive)

- **Desktop / Tablet landscape:** Visible as specified (48px left column).
- **Tablet portrait / Phone:** Hidden. Replaced by BottomNav. The Rail
  component is not mounted on these tiers (unlike mode shells, which are
  always mounted — the Rail itself is tier-conditional).

### TabBar (responsive)

- **Desktop / Tablet landscape:** Full behavior as specified.
- **Tablet portrait / Phone:** Horizontal scroll with no visible scrollbar.
  Tabs show filename only (no path, no dirty dot text — just the dot if
  dirty). Tab close via long-press context sheet (not hover-revealed X).
  Overflow: right-edge chevron indicator.

### FileExplorer (responsive)

- **Desktop / Tablet landscape:** Sidebar as specified (200px default).
- **Tablet portrait:** Collapsible toggle button. Opens as an overlay.
- **Phone:** Left drawer (85% viewport width). Triggered by hamburger icon
  or left-edge swipe. Dismisses on file selection.

### StatusBar (responsive)

> **Decision:** No StatusBar on Phone or Tablet portrait. Connection status
> folds into BottomNav mode chrome (the "More" overflow or a small indicator
> dot); word count is already document-scoped in the editor chrome.
>
> **Rationale:** A 24px status strip is wasted vertical space on a small
> screen. Both pieces of information the StatusBar carries (connection status
> and word count) have natural homes elsewhere that are already defined:
> connection status in the BottomNav overflow, word count in the editor
> title header. Removing the StatusBar on Phone/Tablet portrait recovers
> 24px of content height with zero information loss.
>
> **Rejected:** Keeping StatusBar on Phone — wastes screen real estate for
> information that is already visible in more natural locations.

- **Desktop / Tablet landscape with Rail:** Visible as specified (24px bottom).
- **Tablet portrait / Phone:** Hidden. Connection status folds into the
  BottomNav "More" overflow or into a small indicator dot on the BottomNav.
  Word count remains in editor chrome.

### PanelResizeHandle (responsive)

- **Desktop / Tablet landscape:** Drag-to-resize as specified.
- **Tablet portrait / Phone:** Not rendered. Panes are full-screen or
  drawer/sheet — no continuous resize. See `layouts/overview.md` §Responsive
  Tiers.

---

## Component States: Error, Empty, Loading

Every component that displays data must handle three non-ideal states:

### Loading

- Use `Skeleton` component for content placeholders
- Skeleton shapes should approximate the real content (text lines for text,
  rectangles for cards, circles for avatars)
- Skeleton uses `muted` background with subtle pulse animation
- Loading states appear within 200ms — no spinner for fast loads

### Empty

- Empty states show a centered message with:
  - Phosphor icon (32px, `muted-foreground`)
  - Short heading (`text-base`, `foreground`)
  - Description (`text-sm`, `muted-foreground`)
  - Optional action button
- Thread list empty: "No conversations yet" + "Start a conversation" button
- File explorer empty: "No documents" + "Create a document" button
- Agents dashboard empty: "No active sessions" + description of what sessions
  are

### Error

- Error states show a centered message with:
  - Phosphor `Warning` icon, `destructive` color
  - Error heading
  - Brief description of what went wrong
  - "Try again" button when retry is possible
- Connection errors: StatusBar connection indicator turns `destructive`;
  toast notification with retry option
- Editor frozen states: inline banner above editor content explaining the
  freeze reason (document deleted, access revoked) with recovery actions

---

## Accessibility Patterns

### Keyboard Navigation

- All interactive elements are reachable via Tab
- Focus order follows visual reading order (left-to-right, top-to-bottom)
- Composite widgets (menus, trees, tabs) use arrow keys for internal navigation
- `Escape` closes the innermost overlay (dialog, popover, dropdown)
- See `interaction/navigation.md` for the full keyboard map

### ARIA Patterns

| Component | ARIA pattern |
|---|---|
| Rail | `role="tablist"` with `role="tab"` per mode icon |
| BottomNav | `role="tablist"` with `role="tab"` per tab (same pattern as Rail) |
| File explorer | `role="tree"` with `role="treeitem"` (Ark UI provides this) |
| Tab bar | `role="tablist"` with `role="tab"` per tab |
| Tool group | `role="group"` with collapsible `aria-expanded` |
| Composer | `role="textbox"` with `aria-label` (CM6 provides this) |
| AccessoryBar | `role="toolbar"` with `aria-label="Formatting"` |
| HunkReviewSheet | `role="dialog"` with `aria-label` |
| Status bar | `role="status"` for connection indicator |
| Toast | `role="alert"` (sonner provides this) |
| PanelResizeHandle | `role="separator"` with `aria-orientation`, `aria-valuenow/min/max` |

### Inactive Mode Shells

Inactive mode shells remain mounted but are removed from the accessibility
tree: `display:none` + `aria-hidden="true"` + `inert`. Focus is explicitly
restored to the last focused element in the newly active mode on switch.
Non-essential work (streaming animations, observer-driven layout,
`requestAnimationFrame` loops, auto-scroll reactions) is paused while
inactive; essential connections, sync, and persistence keep running.
See `layouts/overview.md` §CSS Mounting Strategy for the accessibility rule
and §Active/Inactive Work Contract for the pause rules.

### Screen Reader

- Mode switching announces: "Switched to [mode name]" via `aria-live="polite"`
- Tab closing announces: "Closed [filename]" via `aria-live="polite"`
- Streaming status announces periodically: "Assistant is responding" via
  `aria-live="polite"` with debounce (no announcement per token)
