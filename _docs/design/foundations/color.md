# Color

Two themes — Paper (light) and Espresso (dark) — unified by warm neutrals,
a jade-teal accent, and strict contrast rules.

---

## Design Intent

Color serves three functions:

1. **Warmth.** The "paper aesthetic" — warm cream, warm browns, warm grays.
   Nothing sterile or cold. The background feels like parchment, not a
   spreadsheet.
2. **Hierarchy.** Surface layers (canvas → card → popover) and text tones
   (primary → secondary → muted) create spatial depth without heavy borders
   or shadows.
3. **Meaning.** Functional colors (teal for active/accent, green for success,
   vermillion for destructive, amber for warning) carry semantic weight. They
   are used sparingly and always for a reason.

*Evidence: The calmest current interfaces use low-chroma large surfaces, warm
off-whites/near-blacks, and limited accent palettes
(design-language-best-practices §3).*

---

## Color Space

All color tokens are defined in **OKLCH** — a perceptual color space where
lightness, chroma, and hue are independent and perceptually uniform. This
makes it possible to create consistent ramps and predictable contrast
relationships.

Hex values in this spec are approximations for reference only. The OKLCH
values in `tokens.md` are canonical.

---

## Paper (Light Theme)

The default theme. Warm, bright, parchment-like.

### Surface Layers

| Surface | Token | OKLCH | Hex ≈ | Use |
|---|---|---|---|---|
| Canvas | `--background` | `0.960 0.008 85` | `#F6F2EA` | App background |
| Sidebar | `--sidebar` | `0.950 0.008 85` | `#F0ECE4` | Rail, sidebar bg |
| Card | `--card` | `0.970 0.006 85` | `#F8F4ED` | Cards, elevated containers |
| Popover | `--popover` | `0.975 0.005 85` | `#FAF7F0` | Popovers, dropdowns |
| Muted | `--muted` | `0.925 0.010 85` | `#E8E3D9` | Subtle background fills |
| Secondary | `--secondary` | `0.925 0.010 85` | `#E8E3D9` | Secondary button bg |

**Note:** Surface layers get *lighter* as they elevate in light mode (canvas →
card → popover). This is the opposite of dark mode, where elevated surfaces
are *lighter* than the canvas but still dark.

### Text Hierarchy

| Level | Token | OKLCH | Hex ≈ | Contrast on canvas | Use |
|---|---|---|---|---|---|
| Primary | `--foreground` | `0.190 0.018 75` | `#1F1A12` | 15.5:1 | Body text, headings |
| Secondary | `--secondary-foreground` | `0.250 0.016 75` | `#3A3228` | 11.2:1 | Subtitles, descriptions |
| Muted | `--muted-foreground` | `0.490 0.010 75` | `#6B6358` | 4.6:1 | Timestamps, helper text, captions |
| Accent text | `--accent-text` | `0.420 0.090 175` | `#0E6A5A` | 5.1:1 | Teal text (links, active labels) |

### Borders

| Token | OKLCH | Use |
|---|---|---|
| `--border` | `0.895 0.008 85` | Default borders — subtle, warm |
| `--input` | `0.895 0.008 85` | Input field borders (same as default) |

---

## Espresso (Dark Theme)

Late-night writing. Warm dark brown, not cold black.

### Surface Layers

| Surface | Token | OKLCH | Hex ≈ | Use |
|---|---|---|---|---|
| Canvas | `--background` | `0.175 0.006 55` | `#1C1917` | App background |
| Sidebar | `--sidebar` | `0.205 0.008 55` | `#272321` | Rail, sidebar bg |
| Card | `--card` | `0.215 0.008 55` | `#2E2824` | Cards, elevated containers |
| Popover | `--popover` | `0.215 0.008 55` | `#2E2824` | Popovers, dropdowns |
| Muted | `--muted` | `0.250 0.008 55` | `#3A3530` | Subtle background fills |
| Secondary | `--secondary` | `0.250 0.008 55` | `#3A3530` | Secondary button bg |

**Note:** In Espresso, elevated surfaces are lighter than the canvas — the
standard dark-mode pattern for establishing depth.

### Text Hierarchy

| Level | Token | OKLCH | Hex ≈ | Contrast on canvas | Use |
|---|---|---|---|---|---|
| Primary | `--foreground` | `0.940 0.010 80` | `#F0EBE3` | 14.7:1 | Body text, headings |
| Secondary | `--secondary-foreground` | `0.940 0.010 80` | `#F0EBE3` | 14.7:1 | (Same in dark) |
| Muted | `--muted-foreground` | `0.650 0.008 65` | `#9B9489` | 5.8:1 | Timestamps, helper text |
| Accent text | `--accent-text` | `0.745 0.115 175` | `#40C8B0` | 7.4:1 | Teal text (links, active labels) |

### Borders

| Token | OKLCH | Use |
|---|---|---|
| `--border` | `oklch(1 0 0 / 10%)` | Translucent white border |
| `--input` | `oklch(1 0 0 / 15%)` | Slightly stronger for inputs |

---

## Accent System

### Jade-Teal: The Accent Voice

One accent color family — jade-teal — used for all active, interactive, and
emphasis states. This restraint is intentional: a single accent voice keeps
the interface calm and avoids the "dashboard rainbow" problem.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent-fill` | `oklch(0.555 0.100 175)` | `oklch(0.745 0.115 175)` | Icons, borders, fills, decorative elements |
| `--accent-text` | `oklch(0.420 0.090 175)` | `oklch(0.745 0.115 175)` | Text that needs to be teal |
| `--ring` | Same as `accent-fill` | Same as `accent-fill` | Focus ring |

### Usage Rule

> **Decision:** Teal-colored text always uses `accent-text`. The `accent-fill`
> token is never used for text. In light mode, `accent-fill` fails WCAG AA for
> text (3.75:1); `accent-text` passes (5.1:1). In dark mode both values are
> identical (7.4:1 on espresso), so the rule has no cost.
>
> **Rationale:** A single clear rule is easier to audit than context-dependent
> switching. Component authors don't need to check contrast — they use
> `accent-text` for text, `accent-fill` for everything else.

### Where Teal Appears

| Context | Token | Form |
|---|---|---|
| Rail active indicator | `accent-fill` | Left bar (2px width) |
| Active tab underline | `accent-fill` | Bottom border |
| Active file explorer row | `accent-fill` at ~8% opacity | Background tint |
| Link text (in editor, in turns) | `accent-text` | Text color |
| Focus ring | `ring` at 50% opacity | 3px outline |
| Dirty tab indicator dot | `accent-fill` | Small filled circle |
| Panel resize handle hover | `accent-fill` | Tint on handle |
| Status badge (active) | `accent-fill` | Badge fill |
| Button primary (override) | `--primary` (near-black) | **Not teal** — primary buttons use near-black |

**Note:** Primary buttons use `--primary` (near-black/cream), not teal. Teal
is the accent voice for state and emphasis, not the primary action color. This
keeps the interface calm — teal indicates "active" or "interactive," while
near-black/cream indicates "do this."

---

## Functional Colors

Semantic colors that carry meaning. Used sparingly.

### Success

| Context | Token | Use |
|---|---|---|
| Accepted edit hunk | `--success` | Background decoration in editor |
| Success badge | `--success` | Badge variant fill |
| Success toast | `--success` | Toast accent |
| Text on success bg | `--success-foreground` | Badge text, toast text |

### Destructive

| Context | Token | Use |
|---|---|---|
| Discard action | `--destructive` | Button variant |
| Deleted text hunk | `--destructive` | Background decoration in editor |
| Error state | `--destructive` | Error messages, error badges |
| Destructive toast | `--destructive` | Toast accent |
| Text on destructive bg | `--destructive-foreground` | Badge text, button text, toast text |

### Warning (NEW)

| Context | Token | Use |
|---|---|---|
| Pending proposal | `--warning` | Badge variant fill |
| Unsaved changes | `--warning` | Indicator |
| Continuity alert | `--warning` | Badge, icon tint |
| Text on warning bg | `--warning-foreground` | Badge text |

### Functional Color Values

| Token | Light OKLCH | Dark OKLCH |
|---|---|---|
| `--destructive` | `oklch(0.540 0.140 25)` | `oklch(0.620 0.140 25)` |
| `--destructive-foreground` | `oklch(0.985 0 0)` | `oklch(0.985 0 0)` |
| `--success` | `oklch(0.520 0.100 150)` | `oklch(0.600 0.110 150)` |
| `--success-foreground` | `oklch(0.985 0 0)` | `#151210` (neutral-950) |
| `--warning` | `oklch(0.750 0.130 75)` | `oklch(0.800 0.130 75)` |
| `--warning-foreground` | `#1F1A12` (neutral-900) | `#151210` (neutral-950) |

All functional colors are warm-shifted to harmonize with the neutral ramp.
Vermillion instead of pure red. Warm green, not neon. Amber, not yellow.

---

## Contrast Requirements

Every text/background pairing must meet WCAG 2.2 AA:

| Criterion | Ratio | Applies to |
|---|---|---|
| Normal text (< 24px, or < 19px bold) | ≥ 4.5:1 | All body text, labels, inputs |
| Large text (≥ 24px, or ≥ 19px bold) | ≥ 3:1 | Headings, display text |
| Non-text contrast | ≥ 3:1 | Icons, borders carrying meaning, focus indicators |

### Verified Pairings

| Pairing | Light ratio | Dark ratio | Status |
|---|---|---|---|
| `foreground` on `background` | 15.5:1 | 14.7:1 | ✅ Pass |
| `muted-foreground` on `background` | 4.6:1 | 5.8:1 | ✅ Pass |
| `accent-text` on `background` | 5.1:1 | 7.4:1 | ✅ Pass |
| `accent-fill` on `background` | 3.75:1 | 7.4:1 | ❌ **Fail for text in light** — use `accent-text` |
| `foreground` on `card` | ~14:1 | ~12:1 | ✅ Pass |
| `foreground` on `muted` | ~12:1 | ~12:1 | ✅ Pass |
| `primary-foreground` on `primary` | 15.5:1 | 14.7:1 | ✅ Pass |

#### Functional Text-on-Fill Contrast Matrix

All badge, button, toast, and text-on-fill pairings verified for WCAG AA
(normal text ≥ 4.5:1, large text ≥ 3:1):

| Text token | On background | Light ratio | Dark ratio | WCAG AA |
|---|---|---|---|---|
| `destructive-foreground` | `destructive` | 8.2:1 | 8.4:1 | ✅ Pass |
| `success-foreground` | `success` | 5.8:1 | 5.1:1 | ✅ Pass |
| `warning-foreground` | `warning` | 4.8:1 | 4.5:1 | ✅ Pass (≥ 4.5:1 normal) |
| `foreground` | `muted` | ~12:1 | ~12:1 | ✅ Pass |
| `foreground` | `card` | ~14:1 | ~12:1 | ✅ Pass |
| `foreground` | `secondary` | ~12:1 | ~12:1 | ✅ Pass |
| `secondary-foreground` | `secondary` | ~9:1 | ~9:1 | ✅ Pass |
| `muted-foreground` | `card` | 5.3:1 | 4.8:1 | ✅ Pass |
| `accent-text` | `card` | 4.8:1 | 6.5:1 | ✅ Pass |

**Badge-specific:** All badge variants (`default`, `secondary`, `outline`,
`success`, `warning`, `destructive`) use `*-foreground` for text paired with
`--*-fill` background. All pairings meet WCAG AA at `text-xs` size (11–12px),
which is ≥ 4.5:1 for normal text.

### Dark Mode Considerations

- Dark mode is not an inversion — it's a separately tuned palette.
- Espresso (`#1C1917`) is warmer than standard dark modes; the warm hue must
  be preserved in all dark surface tokens.
- Reduced contrast for extended dark-mode reading is handled by the generous
  leading and warm palette — no special low-contrast mode is needed.

---

## Theme Toggle

- **Mechanism:** `.dark` class on `<html>`, toggled by `ThemeProvider`.
- **Transition:** 200ms color transitions on `background`, `foreground`, and
  `border` using `--duration-moderate` and `--ease-default`.
- **Storage:** `localStorage` key `meridian-theme`.
- **Detection:** `prefers-color-scheme` via `useSyncExternalStore` +
  `matchMedia`.
- **Options:** Light → Dark → System (cycle).
- **Constraint:** No images change between modes — only colors. All
  illustrations and logos must work on both Paper and Espresso backgrounds.
