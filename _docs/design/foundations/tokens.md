# Design Tokens

The token system is the single source of truth for every visual value in the
product. All components consume tokens, never raw values.

---

## Token Architecture

Three layers, from raw to role:

1. **Primitive tokens** — raw values. Color ramps, spacing steps, font
   stacks, radius values, duration/easing curves. Named by value or position,
   not by role. Not used directly in component code.

2. **Semantic tokens** — role-based aliases pointing to primitives. These are
   the tokens components consume: `--background`, `--foreground`,
   `--accent-fill`, `--border`. Light/dark theming swaps semantic mappings;
   primitives stay stable.

3. **Component tokens** — optional, narrowly scoped overrides for a specific
   component when a semantic token doesn't fit. Used sparingly; most
   components should never need one.

*Evidence: The DTCG spec and best-practice research both recommend this
layered structure for maintainability and theming
(design-language-best-practices §1).*

### Implementation

Tokens are CSS custom properties on `:root` (light) and `.dark` (dark),
exposed to Tailwind v4 via `@theme inline {}`.

```
:root { --background: oklch(...); }   ← Semantic token (CSS var)
.dark { --background: oklch(...); }   ← Dark override

@theme inline {
  --color-background: var(--background);  ← Tailwind utility binding
}
```

This lets `bg-background` in Tailwind resolve to the runtime CSS variable,
which swaps automatically between light and dark via the `.dark` class.

---

## Primitive Tokens

### Color Primitives

Not consumed directly. These are the raw values that semantic tokens alias.

**Neutral ramp** (warm, hue ~75–85 in OKLCH):

| Token | OKLCH | Hex approx | Role |
|---|---|---|---|
| `--neutral-0` | `oklch(0.985 0.004 85)` | `#FDFBF7` | Lightest surface |
| `--neutral-50` | `oklch(0.975 0.005 85)` | `#FAF7F0` | Popover bg |
| `--neutral-100` | `oklch(0.970 0.006 85)` | `#F8F4ED` | Card bg |
| `--neutral-150` | `oklch(0.960 0.008 85)` | `#F6F2EA` | Paper (canvas) |
| `--neutral-200` | `oklch(0.950 0.008 85)` | `#F0ECE4` | Sidebar bg |
| `--neutral-250` | `oklch(0.925 0.010 85)` | `#E8E3D9` | Muted/secondary bg |
| `--neutral-300` | `oklch(0.895 0.008 85)` | `#DDD8CE` | Border |
| `--neutral-400` | `oklch(0.750 0.008 80)` | `#B5B0A6` | — |
| `--neutral-500` | `oklch(0.650 0.008 65)` | `#9B9489` | Dark-mode muted text |
| `--neutral-600` | `oklch(0.490 0.010 75)` | `#6B6358` | Light-mode muted text |
| `--neutral-700` | `oklch(0.380 0.012 70)` | `#504839` | — |
| `--neutral-800` | `oklch(0.250 0.016 75)` | `#3A3228` | Secondary fg |
| `--neutral-850` | `oklch(0.215 0.008 55)` | `#2E2824` | Dark card bg |
| `--neutral-900` | `oklch(0.190 0.018 75)` | `#1F1A12` | Near-black (text) |
| `--neutral-925` | `oklch(0.175 0.006 55)` | `#1C1917` | Espresso (canvas) |
| `--neutral-950` | `oklch(0.140 0.006 55)` | `#151210` | Deepest dark |

**Teal ramp** (jade-teal accent, hue ~175):

| Token | OKLCH | Hex approx | Role |
|---|---|---|---|
| `--teal-300` | `oklch(0.745 0.115 175)` | `#40C8B0` | Dark-mode accent |
| `--teal-500` | `oklch(0.555 0.100 175)` | `#1A8B7A` | Light-mode fill accent |
| `--teal-700` | `oklch(0.420 0.090 175)` | `#0E6A5A` | Light-mode text accent |

**Functional ramp**:

| Token | OKLCH (light) | OKLCH (dark) | Role |
|---|---|---|---|
| `--red-500` | `oklch(0.540 0.140 25)` | `oklch(0.620 0.140 25)` | Destructive |
| `--green-500` | `oklch(0.520 0.100 150)` | `oklch(0.600 0.110 150)` | Success |
| `--amber-500` | `oklch(0.750 0.130 75)` | `oklch(0.800 0.130 75)` | Warning/pending |

### Spacing Primitives

8pt grid base. All spacing in the system uses these values.

| Token | Value | Px equiv |
|---|---|---|
| `--space-0` | `0px` | 0 |
| `--space-0-5` | `0.125rem` | 2 |
| `--space-1` | `0.25rem` | 4 |
| `--space-1-5` | `0.375rem` | 6 |
| `--space-2` | `0.5rem` | 8 |
| `--space-2-5` | `0.625rem` | 10 |
| `--space-3` | `0.75rem` | 12 |
| `--space-4` | `1rem` | 16 |
| `--space-5` | `1.25rem` | 20 |
| `--space-6` | `1.5rem` | 24 |
| `--space-8` | `2rem` | 32 |
| `--space-10` | `2.5rem` | 40 |
| `--space-12` | `3rem` | 48 |
| `--space-16` | `4rem` | 64 |
| `--space-20` | `5rem` | 80 |
| `--space-24` | `6rem` | 96 |

### Radius Primitives

| Token | Value | Use |
|---|---|---|
| `--radius-base` | `0.5rem` (8px) | Base reference |
| `--radius-sm` | `0.3rem` (≈5px) | Small controls (badges, chips) |
| `--radius-md` | `0.4rem` (≈6px) | Default controls (buttons, inputs) |
| `--radius-lg` | `0.5rem` (8px) | Cards, panels |
| `--radius-xl` | `0.7rem` (≈11px) | Dialogs, sheets |
| `--radius-2xl` | `0.9rem` (≈14px) | Large containers |
| `--radius-3xl` | `1.1rem` (≈18px) | — |
| `--radius-full` | `9999px` | Circles, pills |

### Duration Primitives

| Token | Value | Use |
|---|---|---|
| `--duration-instant` | `0ms` | Mode switch, panel resize |
| `--duration-fast` | `100ms` | Syntax-marker hide (live preview) |
| `--duration-normal` | `150ms` | Hover states, micro-interactions |
| `--duration-moderate` | `200ms` | Collapse/expand, toast, theme toggle |
| `--duration-slow` | `300ms` | Dialog enter/exit |

### Easing Primitives

| Token | Value | Use |
|---|---|---|
| `--ease-default` | `cubic-bezier(0.2, 0, 0, 1)` | Default motion |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Collapse/expand, exit |
| `--ease-in` | `cubic-bezier(0.8, 0, 1, 1)` | Entry (rare) |
| `--ease-linear` | `linear` | Progress bars, continuous |

---

## Semantic Tokens

These are the tokens component code consumes. They alias into primitives and
swap between light and dark mode.

### Surface & Background

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `neutral-150` | `neutral-925` | App canvas |
| `--foreground` | `neutral-900` | `oklch(0.940 0.010 80)` | Primary text |
| `--card` | `neutral-100` | `neutral-850` | Card background |
| `--card-foreground` | `neutral-900` | `oklch(0.940 0.010 80)` | Card text |
| `--popover` | `neutral-50` | `neutral-850` | Popover background |
| `--popover-foreground` | `neutral-900` | `oklch(0.940 0.010 80)` | Popover text |
| `--sidebar` | `neutral-200` | `oklch(0.205 0.008 55)` | Sidebar/rail bg |
| `--muted` | `neutral-250` | `oklch(0.250 0.008 55)` | Muted surface bg |
| `--muted-foreground` | `neutral-600` | `neutral-500` | Secondary text |

### Primary & Secondary

| Token | Light | Dark | Role |
|---|---|---|---|
| `--primary` | `neutral-900` | `oklch(0.940 0.010 80)` | Primary action bg (near-black buttons) |
| `--primary-foreground` | `neutral-150` | `neutral-925` | Primary action text |
| `--secondary` | `neutral-250` | `oklch(0.250 0.008 55)` | Secondary action bg |
| `--secondary-foreground` | `neutral-800` | `oklch(0.940 0.010 80)` | Secondary action text |

### Accent

| Token | Light | Dark | Role |
|---|---|---|---|
| `--accent` | `neutral-250` | `oklch(0.250 0.008 55)` | Subtle bg accent (shadcn default) |
| `--accent-foreground` | `neutral-900` | `oklch(0.940 0.010 80)` | Text on accent bg |
| `--accent-fill` | `teal-500` | `teal-300` | Jade-teal for icons, borders, fills — **NOT text** |
| `--accent-text` | `teal-700` | `teal-300` | Jade-teal for **text** — WCAG AA on canvas |

Usage rule: any teal-colored text must use `accent-text`. `accent-fill` is
for icons, borders, decorative fills, and non-text UI elements only.
In dark mode both resolve to the same value (7.4:1 on espresso passes AA).

### Functional

| Token | Light | Dark | Role |
|---|---|---|---|
| `--destructive` | `red-500 light` | `red-500 dark` | Destructive actions, errors |
| `--success` | `green-500 light` | `green-500 dark` | Accepted edits, positive state |
| `--destructive-foreground` | `oklch(0.985 0 0)` | `oklch(0.985 0 0)` | Text on destructive bg |
| `--success-foreground` | `oklch(0.985 0 0)` | `neutral-925` | Text on success bg |
| `--warning` | `amber-500 light` | `amber-500 dark` | **NEW:** Pending state, caution |
| `--warning-foreground` | `neutral-900` | `neutral-925` | Text on warning bg |

> **Note:** `--warning` is new — not yet in `index.css`. Must be added during
> implementation.

### Border & Input

| Token | Light | Dark | Role |
|---|---|---|---|
| `--border` | `neutral-300` | `oklch(1 0 0 / 10%)` | Default border |
| `--input` | `neutral-300` | `oklch(1 0 0 / 15%)` | Input border |
| `--ring` | `teal-500` | `teal-300` | Focus ring color |

### Elevation

| Token | Value | Role |
|---|---|---|
| `--elevation-none` | `none` | **NEW:** Default surface — no shadow |
| `--elevation-subtle` | `0 1px 3px oklch(0 0 0 / 4%)` | **NEW:** Composer edge, tooltip |
| `--elevation-overlay` | `0 4px 12px oklch(0 0 0 / 10%)` | **NEW:** Floating toolbars, dropdowns, command palette |

Dark-mode overrides: `--elevation-subtle` → `0 1px 3px oklch(0 0 0 / 15%)`,
`--elevation-overlay` → `0 4px 12px oklch(0 0 0 / 25%)`.

See `foundations/elevation.md` for the full elevation system.

### Interaction

| Token | Value | Role |
|---|---|---|
| `--focus-ring-width` | `3px` | **NEW:** Focus-visible ring width |
| `--focus-ring-opacity` | `50%` | Focus ring opacity |
| `--touch-target-min` | `44px` | **NEW:** Minimum interactive target size |

### Editor Rhythm

| Token | Value | Role |
|---|---|---|
| `--editor-measure` | `68ch` | **NEW:** Editor column width |
| `--editor-leading` | `1.65` | **NEW:** Editor line-height |
| `--editor-paragraph-spacing` | `1em` | **NEW:** Space between paragraphs |
| `--editor-font-size` | `clamp(1rem, 0.95rem + 0.2vw, 1.125rem)` | **NEW:** Editor base size (16–18px) |

### Semantic Spacing (Component Padding)

| Token | Value | Role |
|---|---|---|
| `--padding-compact` | `0.5rem` (8px) | **NEW:** Dense chrome, toolbar items |
| `--padding-default` | `0.75rem` (12px) | **NEW:** Standard component padding |
| `--padding-relaxed` | `1rem` (16px) | **NEW:** Spacious elements, cards |

### Responsive Shell

| Token | Value | Role |
|---|---|---|
| `--bottom-nav-height` | `56px` | **NEW:** BottomNav height (excludes safe-area padding) |
| `--accessory-bar-height` | `44px` | **NEW:** AccessoryBar height above keyboard |

These are structural shell constants for the mobile layout. Safe-area
insets (`env(safe-area-inset-*)`) are consumed directly from the CSS
environment — they are not custom tokens because their values are set
by the device, not by the design system. See `foundations/responsive.md`.

---

## Tailwind v4 `@theme` Mapping

The `@theme inline {}` block in `index.css` bridges CSS variables to Tailwind
utilities. This is the existing pattern; new tokens follow the same shape:

```css
@theme inline {
  /* Existing */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-accent-fill: var(--accent-fill);
  --color-accent-text: var(--accent-text);
  /* ... all existing color mappings ... */

  /* NEW: Warning */
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);

  /* NEW: Destructive foreground */
  --color-destructive-foreground: var(--destructive-foreground);

  /* NEW: Elevation */
  --shadow-elevation-subtle: var(--elevation-subtle);
  --shadow-elevation-overlay: var(--elevation-overlay);

  /* NEW: Editor rhythm */
  --spacing-editor-measure: var(--editor-measure);

  /* NEW: Semantic spacing */
  --spacing-padding-compact: var(--padding-compact);
  --spacing-padding-default: var(--padding-default);
  --spacing-padding-relaxed: var(--padding-relaxed);

  /* NEW: Motion */
  --duration-instant: var(--duration-instant);
  --duration-fast: var(--duration-fast);
  --duration-normal: var(--duration-normal);
  --duration-moderate: var(--duration-moderate);
  --duration-slow: var(--duration-slow);

  --ease-default: var(--ease-default);
  --ease-out: var(--ease-out);

  /* NEW: Interaction */
  --spacing-touch-target: var(--touch-target-min);

  /* NEW: Responsive shell */
  --spacing-bottom-nav-height: var(--bottom-nav-height);
  --spacing-accessory-bar-height: var(--accessory-bar-height);
}
```

This allows component code to use `duration-normal`, `ease-out`,
`p-padding-default`, `text-warning`, etc. as native Tailwind utilities.

---

## Token Inventory: What Exists vs. What's New

| Category | Exists in `index.css` | New in this spec |
|---|---|---|
| Surface colors | ✅ Full set | — |
| Accent dual tokens | ✅ `accent-fill`, `accent-text` | — |
| Success | ✅ | — |
| Destructive | ✅ | — |
| Warning/Pending | ❌ | `--warning`, `--warning-foreground` |
| Fluid type scale | ✅ 8 sizes | — |
| Font families | ✅ 3 families | — |
| Spacing grid | ✅ 15 tokens | — |
| Semantic spacing | ❌ | `--padding-compact/default/relaxed` |
| Radius | ✅ 7 levels | — |
| Duration | ❌ | 5 tokens |
| Easing | ❌ | 4 tokens |
| Focus ring | ❌ (hardcoded `ring-[3px]`) | `--focus-ring-width`, `--focus-ring-opacity` |
| Touch target | ❌ | `--touch-target-min` |
| Elevation | ❌ | 3 tokens (`--elevation-none/subtle/overlay`) |
| Editor rhythm | ❌ | 4 tokens |
| Responsive shell | ❌ | 2 tokens (`--bottom-nav-height`, `--accessory-bar-height`) |

---

## Token Discipline: Raw Value Whitelist

The token-first rule means components consume tokens, never raw values.
However, certain layout constants are structural and are **whitelisted** to
remain as raw values without dedicated tokens:

| Category | Allowed raw values | Rationale |
|---|---|---|
| Shell widths | `48px` (rail), `24px` (status bar), `36px` (tab bar, explorer header), `56px` (BottomNav excl. safe-area), `44px` (AccessoryBar) | Structural constants tied to component identity; unlikely to change independently. BottomNav and AccessoryBar heights are also available as tokens (`--bottom-nav-height`, `--accessory-bar-height`) for layout calculations. |
| Hit areas | `36px × 36px` (rail icons) | Documented as invisible hit-padding; see `components.md` §Touch Targets |
| Scroll/fade zones | `28px` (FloatingScrollLayout masks) | Single-use internal constant |
| Opacities in component definitions | e.g., `30%` user-turn tint, `50%` tool-group bg | Opacities are inherently relative to the underlying color token; extracting them adds indirection without value |
| CM6-specific offsets | `1.5rem 1.75rem` (editor padding) | Editor-specific rhythm tuned to font metrics |
| Animation exceptions | Skeleton shimmer `animation-delay` offsets | One-off animation values |
| FloatingScrollLayout | Scroll behavior thresholds (e.g., `200px` auto-scroll threshold) | Internal component constants |

Everything else — colors, spacing, radii, durations, easings, shadows,
font sizes, font families, line-heights, focus-ring dimensions, touch targets —
**must** use tokens.

When a layout constant appears in **two or more** components, promote it to a
token. This whitelist is reviewed whenever a new component is added.
