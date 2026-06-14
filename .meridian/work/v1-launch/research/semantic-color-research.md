# Semantic Color Research for Warm/Tinted Design Systems

Research for deriving success (green), warning (amber), and destructive (red) semantic
colors that harmonize with Meridian's warm paper palette using OKLCH tokens.

**Context**: Light mode background is `oklch(0.960 0.008 85)` (~#F6F2EA, warm paper).
Dark mode background is `oklch(0.175 0.006 55)` (~#1C1917, espresso).

---

## 1. OKLCH Hue Map and Semantic Color Positions

Reference hue positions in OKLCH (from Evil Martians and MDN documentation):

| Color    | OKLCH Hue | Notes                          |
|----------|-----------|--------------------------------|
| Red      | ~20       | Destructive/error              |
| Orange   | ~55       | (Meridian's background hue)    |
| Yellow   | ~90       | Caution, but low contrast risk |
| Lime     | ~120      | Yellow-green transition zone   |
| Green    | ~140-150  | Success, positive              |
| Teal     | ~175-185  | Cool green-blue                |
| Cyan     | ~195      |                                |
| Blue     | ~220      | Info, primary                  |
| Purple   | ~320      |                                |

The background hue of 85 (light) and 55 (dark) sits in the yellow-orange zone.
Semantic hues need to be far enough from this to read as distinct colors, but can
be pulled slightly toward it for warmth.

---

## 2. Warm-Shifting Hues: How Far Can You Go?

### The Green Boundary

In OKLCH, "green" is centered at hue ~140. The yellow-green transition zone runs
from ~100 to ~130. Research on color category perception shows:

- **Hue 90-100**: Reads as yellow or yellow-green. Too close to the background hue
  (85) to function as a distinct semantic signal.
- **Hue 105-120**: Reads as "warm green" / "chartreuse" / "lime." Still identifiable
  as a green-family color, but may feel acidic or toxic at high chroma. This is the
  warmest a "success green" can go while still reading as green.
- **Hue 125-135**: Reads as a warm, earthy, or olive green. This is the sweet spot
  for a warm-shifted success color -- clearly green, but harmonious with warm
  backgrounds.
- **Hue 140-155**: Standard green. Neutral temperature. Works but may feel clinical
  against warm paper.
- **Hue 160+**: Cool green, leaning teal/mint. Increasingly dissonant with warm
  backgrounds.

**Recommendation for Meridian**: Target success hue around **145-155** (jade-green
range, slightly past pure green toward teal) for the accent/brand color. If using the
brand accent as a separate success semantic, a warm-shifted green at **128-135** creates
harmonious distinctness from the teal accent. See section 6 for the accent-as-success
question.

### The Red/Destructive Boundary

Red in OKLCH sits at hue ~20-30. The background hue (85/55) is far enough away that
warm-shifting red is unnecessary -- red already lives in the warm zone. However:

- **Hue 15-20**: Standard red. Works well.
- **Hue 25-30**: Slightly warm red (vermillion). Can harmonize better with
  yellow-toned backgrounds.
- **Hue 5-10**: Cool red (crimson/rose). Creates more contrast against warm
  backgrounds but feels more clinical.

**Recommendation**: Hue **25** for destructive. This is a warm red that naturally
belongs in the same temperature family as the paper background.

### The Warning/Amber Boundary

Warning is the trickiest because amber/yellow sits very close to the background hue:

- **Hue 70-80**: Pure amber/golden. Very close to the background hue (85). Risk:
  low contrast against the warm paper surface at light tints.
- **Hue 55-65**: Orange-amber. More distinct from the background. Better
  differentiation from the paper tone.
- **Hue 85-90**: Yellow. Nearly identical to the background hue. Avoid for warning
  on warm paper.

**Recommendation**: Hue **70** for warning. This is amber tilted slightly toward
orange, giving it enough distance from the background hue (85) to read as a distinct
signal while staying in the warm family. Avoid pure yellow (90) which would disappear
into the warm paper.

---

## 3. Chroma Balancing on Desaturated Surfaces

### The Core Problem

Meridian's background has chroma 0.008 (light) and 0.006 (dark). This is nearly
achromatic. Semantic colors need enough chroma to communicate meaning but not so
much that they scream against the quiet surface.

### Chroma Ranges by Role

From Evil Martians' Tailwind OKLCH research, real-world design system analysis, and
OKLCH palette tools, here are practical chroma ranges:

| Role               | Chroma Range  | Notes                                         |
|--------------------|---------------|-----------------------------------------------|
| Tinted surface/bg  | 0.02-0.05     | Subtle wash of color. 3-6x background chroma  |
| Subtle border      | 0.04-0.07     | Visible tint but not aggressive               |
| Strong border      | 0.08-0.12     | Clear color identity                          |
| Icon / indicator   | 0.10-0.16     | Needs to read at small sizes                  |
| Text on surface    | 0.08-0.14     | Must pair with accessible contrast            |
| Solid fill (badge) | 0.12-0.18     | Primary semantic signal                       |
| Vivid accent       | 0.16-0.24     | Brand moments, active states                  |

### Chroma Proportionality Guideline

There is no published standard ratio, but a practical guideline emerges from
analyzing Radix, Polaris, and Geist color systems:

- **Tinted backgrounds**: 3-8x the background chroma (0.024-0.064 on a 0.008 surface)
- **Solid fills/badges**: 15-25x the background chroma (0.12-0.20)
- **Vivid accents/CTAs**: 20-30x the background chroma (0.16-0.24)

The current token chroma values of 0.160-0.245 are reasonable for vivid accent use
(buttons, links, active states) but would be too intense for tinted backgrounds or
subtle badges. Each semantic color needs a **ramp** from low chroma (surfaces) to
high chroma (fills/text).

### Evil Martians' Calibrated Chroma Ramp

From their Tailwind OKLCH theme article, a manually-calibrated chroma array for an
11-step ramp (50-950):

```
[0.0108, 0.0321, 0.0609, 0.0908, 0.1398, 0.1472, 0.1299, 0.1067, 0.0898, 0.0726, 0.054]
```

This shows chroma peaking in the middle of the ramp (steps 400-500, around 0.14-0.15)
and tapering at both light and dark extremes. This is consistent with how sRGB gamut
constrains chroma at extreme lightness values.

---

## 4. OKLCH Lightness Levels for Semantic Color Roles

### Light Mode (on ~0.96 L background)

| Role                     | L Value     | Notes                                    |
|--------------------------|-------------|------------------------------------------|
| Tinted surface           | 0.93-0.95   | Subtle, 1-3% darker than page bg         |
| Hover surface            | 0.90-0.92   | Visible state change                     |
| Active surface           | 0.87-0.90   | Clear pressed state                      |
| Subtle border            | 0.85-0.88   | Low-key separation                       |
| Default border           | 0.78-0.82   | Standard component border                |
| Hover border             | 0.72-0.76   | Interactive feedback                     |
| Solid fill (badge/pill)  | 0.55-0.65   | Primary semantic surface                 |
| Icon                     | 0.50-0.60   | Must be readable at 16-20px              |
| Secondary text           | 0.45-0.55   | Labels, descriptions on tinted surfaces  |
| Primary text             | 0.30-0.40   | High contrast body text on tinted bg     |

### Dark Mode (on ~0.175 L background)

| Role                     | L Value     | Notes                                    |
|--------------------------|-------------|------------------------------------------|
| Tinted surface           | 0.20-0.23   | Subtle, slightly lighter than page bg    |
| Hover surface            | 0.24-0.27   | Visible state change                     |
| Active surface           | 0.28-0.31   | Clear pressed state                      |
| Subtle border            | 0.28-0.32   | Low-key separation                       |
| Default border           | 0.35-0.40   | Standard component border                |
| Hover border             | 0.42-0.48   | Interactive feedback                     |
| Solid fill (badge/pill)  | 0.45-0.55   | Primary semantic surface                 |
| Icon                     | 0.55-0.65   | Must be readable at 16-20px              |
| Secondary text           | 0.60-0.70   | Labels, descriptions on tinted surfaces  |
| Primary text             | 0.85-0.92   | High contrast body text on tinted bg     |

### Key Insight: Perceptual Uniformity

Because OKLCH lightness is perceptually uniform, you can set the same L value for
success, warning, and destructive at each role tier and get visually equivalent weight.
This is the primary advantage over HSL-based systems (where "green at L=50" looks
much darker than "yellow at L=50"). Shopify Polaris and Radix both exploit this
property: "Red 12 and Blue 12 will have identical contrast ratios when paired with
the same color."

---

## 5. WCAG Contrast Requirements

### WCAG 2.1 Requirements (Current Standard)

| Use Case                          | Criterion | Min Ratio | Notes                           |
|-----------------------------------|-----------|-----------|----------------------------------|
| Normal text (<18px / <14px bold)  | 1.4.3 AA  | 4.5:1     | Body text, labels                |
| Large text (>=18px / >=14px bold) | 1.4.3 AA  | 3:1       | Headings, prominent labels       |
| Normal text AAA                   | 1.4.6 AAA | 7:1       | Enhanced readability             |
| UI components & graphical objects | 1.4.11 AA | 3:1       | Borders, icons, badges, controls |
| Inactive components               | --        | Exempt    | Grayed-out disabled states       |

### APCA Lc Thresholds (Emerging Standard)

APCA (Advanced Perceptual Contrast Algorithm) provides more nuanced thresholds:

| Use Case                    | Min Lc | Notes                                  |
|-----------------------------|--------|----------------------------------------|
| Body text, columns          | 75-90  | Lc 90 preferred, 75 minimum           |
| Content text (non-body)     | 60     | Captions, subtitles                    |
| Headlines (36px+ / 24px bold) | 45   | Also large pictograms                 |
| Spot-readable text, icons   | 30     | Placeholders, disabled text, solid icons |
| Non-text decorative elements | 15    | Minimum visibility threshold           |

### How This Constrains Semantic Colors

**Semantic text on white/light backgrounds**: With a page background L of 0.96,
semantic text needs L <= ~0.55 to achieve 4.5:1 contrast (AA). For AAA (7:1), text
needs L <= ~0.42.

**Semantic text on tinted semantic backgrounds**: A success tinted background at
L=0.93 with chroma 0.04 requires text at L <= ~0.52 for 4.5:1.

**Badge/pill text on solid fill**: If the badge fill is L=0.55, white text (L=1.0)
gives about 4.2:1 -- barely AA for large text. Dark text (L=0.20) gives about 4.5:1.
This means **solid semantic badges at mid-lightness need dark text**, or the fill must
be darker (L <= 0.45) for white text to hit 4.5:1.

**Icon contrast**: Semantic icons at L=0.55 on a L=0.96 background give about 3.7:1,
clearing the 3:1 UI component threshold. But for icons that also serve as the sole
indicator (no text label), aim for 4.5:1 (L <= 0.50).

### OKLCH Lightness as Contrast Proxy

A useful heuristic from CSS-Tricks: when OKLCH lightness is >= 0.72, black text
always contrasts better than white; below 0.65, white always contrasts better. Between
0.65-0.72, both work with moderate contrast. This means:

- Semantic backgrounds (L > 0.72): always use dark semantic text
- Semantic fills (L < 0.65): always use white/light text
- Avoid fills in the 0.65-0.72 "no-man's land" for text-bearing components

---

## 6. Using Brand Accent (Jade-Teal) as Success Color

### The Case For

- Reduces the color palette footprint (fewer colors = cleaner visual language)
- Jade/teal is in the green family (hue ~165-175 in OKLCH), so it already carries
  "positive" associations
- Many successful products use green-family brand colors that double as success
  indicators (Spotify, WhatsApp)

### The Case Against

Atlassian's design documentation explicitly warns: **"Don't use an accent when the
color has semantic meaning."** The core problems:

1. **Ambiguity**: When a jade button appears next to a jade "success" badge, users
   cannot tell if the badge is communicating state or just following the brand palette.
   Is the badge saying "this succeeded" or is it just a styled tag?

2. **Collision in context**: Interactive elements (buttons, links) share the same
   visual language as status indicators (badges, alerts). A jade "Save" button next
   to a jade "Saved successfully" toast creates confusion -- the action and its
   confirmation look identical.

3. **Reduced expressiveness**: If you need to show a success state on an accent-
   colored element (e.g., a primary button that transitions to "saved"), you have no
   visual change to communicate the state transition.

4. **Naming confusion**: Developers face "is this button primary, or an accent, or
   semantic?" decisions, as documented by Adobe's naming research.

### Recommendation

**Separate the accent from success, but keep them in the same temperature family.**

- **Accent (brand)**: Jade-teal, hue ~165-175. Used for interactive elements,
  links, primary buttons, focus rings.
- **Success (semantic)**: Warm green, hue ~140-150. Used for success badges, positive
  states, completion indicators, valid form fields.

The ~20-30 degree hue difference is enough to distinguish them in context while both
feel harmonious in the warm palette. If the brand accent were blue (hue 220), this
problem would not exist -- it only arises because jade/teal is in the green family.

Alternatively, if palette minimalism is paramount, use the accent for success **but**
add a secondary signal: a checkmark icon, distinct typography, or a label. Never rely
on color alone (per WCAG 1.4.1).

---

## 7. Real-World Examples

### Radix Colors (Used by Radix UI, Shadcn)

Radix is the closest precedent for Meridian's approach:

- **12-step scale** per color, each step mapped to a specific role:
  - Steps 1-2: Backgrounds (app bg, subtle bg)
  - Steps 3-5: Interactive backgrounds (default, hover, active)
  - Steps 6-8: Borders (subtle, default, hover)
  - Steps 9-10: Solid fills
  - Steps 11-12: Text (secondary, primary)
- **Tinted neutrals**: Sand (yellow-tinted), Olive (lime-tinted), Sage (green-tinted).
  The recommendation is to pick the gray scale with the hue closest to your accent.
  For Meridian's warm paper, **Sand** is the closest match.
- **Semantic mapping**: Success maps to green, jade, teal, grass, or mint. Warning
  maps to yellow, amber, orange. Error maps to red, ruby, tomato, crimson.
- **Caveat**: Radix notes that "saturated grays as app backgrounds in dark mode may
  clash with colorful UI components like badges."

### Notion

Notion uses warm-shifted semantic colors that work well on their light cream-ish
backgrounds:

- **Light mode green**: Text `#548164`, Background `#EEF3ED`
- **Light mode red**: Text `#C4554D`, Background `#FAECEC`
- **Light mode orange**: Text `#CC782F`, Background `#F8ECDF`
- **Dark mode green**: Text `#4F9768`, Background `#242B26`
- **Dark mode red**: Text `#BE524B`, Background `#332523`

These are muted, earthy tones -- not vivid/saturated. The green is a sage-like warm
green, the red is a terracotta-leaning warm red. They harmonize with Notion's warm
neutral backgrounds because chroma is kept moderate.

### Linear

- Uses **LCH color space** for theme generation (perceptually uniform, like OKLCH)
- Shifted from cool blue-gray to **warmer, less saturated neutrals** in their recent
  redesign, noting that "going too warm risks making the interface look muddy"
- Simplified their color system to **three variables per theme**: base color, accent
  color, contrast
- Generated semantic surfaces, text, icons, and controls from operations on these
  three variables
- Deliberately "limited how much chrome (blue) was used in calculations" to achieve
  warmer tones without muddiness

### Shopify Polaris

- Uses **HSLuv color space** (perceptually uniform, similar rationale to OKLCH)
- 16 shades per color, ensuring "Red 12 and Blue 12 have identical contrast ratios
  when paired with the same color"
- Three semantic categories: Success, Warning, Critical
- Distinguishes between `bg-surface` (large area, more subtle) and `bg-fill` (small
  area like badges, more vivid) -- Meridian should adopt this pattern
- Token structure: `color-{role}-{element}-{modifier}` (e.g.,
  `color-success-bg-surface`, `color-success-text`)

### Vercel Geist

- **10 color scales** including semantic: green (success), amber (warning), red (error)
- Uses P3 colors on supported displays
- Semantic tokens follow `--ds-{color}-{step}` pattern (e.g., `--ds-green-700`)
- 10-step scale per semantic color covering backgrounds through text

---

## 8. Proposed OKLCH Values for Meridian

Based on all research above, here are concrete starting points. These should be
validated with a contrast checker and visual testing.

### Hue Selections

| Semantic Role | Hue  | Rationale                                                |
|---------------|------|----------------------------------------------------------|
| Success       | 145  | Warm-leaning green, ~60 degrees from bg hue (85). Reads clearly as green while harmonizing with warm palette. Distinct from jade accent (~170). |
| Warning       | 70   | Amber tilted toward orange. 15 degrees from bg hue -- close enough to feel warm, far enough to be visible against paper. |
| Destructive   | 25   | Warm red/vermillion. Naturally warm, harmonizes with palette without any shifting needed. |

### Light Mode Ramp (on oklch(0.960 0.008 85) background)

**Success (hue 145)**

| Token                    | L     | C     | H   | Role                |
|--------------------------|-------|-------|-----|---------------------|
| success-surface          | 0.940 | 0.035 | 145 | Tinted background   |
| success-surface-hover    | 0.910 | 0.045 | 145 | Hover state         |
| success-border-subtle    | 0.860 | 0.060 | 145 | Subtle border       |
| success-border           | 0.780 | 0.090 | 145 | Default border      |
| success-fill             | 0.550 | 0.150 | 145 | Badge/pill fill     |
| success-icon             | 0.520 | 0.130 | 145 | Standalone icon     |
| success-text             | 0.380 | 0.100 | 145 | Text on light bg    |
| success-text-on-fill     | 0.980 | 0.010 | 145 | Text on solid fill  |

**Warning (hue 70)**

| Token                    | L     | C     | H   | Role                |
|--------------------------|-------|-------|-----|---------------------|
| warning-surface          | 0.945 | 0.035 | 70  | Tinted background   |
| warning-surface-hover    | 0.915 | 0.050 | 70  | Hover state         |
| warning-border-subtle    | 0.870 | 0.065 | 70  | Subtle border       |
| warning-border           | 0.800 | 0.100 | 70  | Default border      |
| warning-fill             | 0.600 | 0.155 | 70  | Badge/pill fill     |
| warning-icon             | 0.560 | 0.140 | 70  | Standalone icon     |
| warning-text             | 0.420 | 0.100 | 70  | Text on light bg    |
| warning-text-on-fill     | 0.200 | 0.020 | 70  | Dark text on fill   |

**Destructive (hue 25)**

| Token                    | L     | C     | H   | Role                |
|--------------------------|-------|-------|-----|---------------------|
| destructive-surface      | 0.940 | 0.030 | 25  | Tinted background   |
| destructive-surface-hover| 0.910 | 0.045 | 25  | Hover state         |
| destructive-border-subtle| 0.850 | 0.065 | 25  | Subtle border       |
| destructive-border       | 0.770 | 0.100 | 25  | Default border      |
| destructive-fill         | 0.520 | 0.175 | 25  | Badge/pill fill     |
| destructive-icon         | 0.500 | 0.160 | 25  | Standalone icon     |
| destructive-text         | 0.400 | 0.120 | 25  | Text on light bg    |
| destructive-text-on-fill | 0.980 | 0.010 | 25  | Light text on fill  |

### Dark Mode Ramp (on oklch(0.175 0.006 55) background)

Dark mode inverts the lightness direction. Surfaces are slightly lighter than the
background; text is much lighter.

**Success (hue 145)**

| Token                    | L     | C     | H   | Role                |
|--------------------------|-------|-------|-----|---------------------|
| success-surface          | 0.210 | 0.025 | 145 | Tinted background   |
| success-surface-hover    | 0.240 | 0.035 | 145 | Hover state         |
| success-border-subtle    | 0.310 | 0.050 | 145 | Subtle border       |
| success-border           | 0.400 | 0.070 | 145 | Default border      |
| success-fill             | 0.500 | 0.140 | 145 | Badge/pill fill     |
| success-icon             | 0.600 | 0.130 | 145 | Standalone icon     |
| success-text             | 0.700 | 0.100 | 145 | Text on dark bg     |
| success-text-on-fill     | 0.150 | 0.020 | 145 | Dark text on fill   |

**Warning (hue 70)**

| Token                    | L     | C     | H   | Role                |
|--------------------------|-------|-------|-----|---------------------|
| warning-surface          | 0.215 | 0.025 | 70  | Tinted background   |
| warning-surface-hover    | 0.250 | 0.040 | 70  | Hover state         |
| warning-border-subtle    | 0.320 | 0.055 | 70  | Subtle border       |
| warning-border           | 0.410 | 0.080 | 70  | Default border      |
| warning-fill             | 0.550 | 0.140 | 70  | Badge/pill fill     |
| warning-icon             | 0.620 | 0.130 | 70  | Standalone icon     |
| warning-text             | 0.730 | 0.100 | 70  | Text on dark bg     |
| warning-text-on-fill     | 0.150 | 0.020 | 70  | Dark text on fill   |

**Destructive (hue 25)**

| Token                    | L     | C     | H   | Role                |
|--------------------------|-------|-------|-----|---------------------|
| destructive-surface      | 0.210 | 0.025 | 25  | Tinted background   |
| destructive-surface-hover| 0.240 | 0.040 | 25  | Hover state         |
| destructive-border-subtle| 0.300 | 0.055 | 25  | Subtle border       |
| destructive-border       | 0.390 | 0.085 | 25  | Default border      |
| destructive-fill         | 0.480 | 0.165 | 25  | Badge/pill fill     |
| destructive-icon         | 0.580 | 0.150 | 25  | Standalone icon     |
| destructive-text         | 0.680 | 0.110 | 25  | Text on dark bg     |
| destructive-text-on-fill | 0.970 | 0.010 | 25  | Light text on fill  |

---

## 9. Implementation Guidelines

### Gamut Safety

OKLCH can specify colors outside the sRGB gamut. At the chroma levels recommended
above (max ~0.175), all values should be within sRGB for hues 25, 70, and 145.
However, always verify. The sRGB gamut boundary varies by hue:

- Greens (hue ~145) have lower max chroma at mid-lightness (~0.18 in sRGB)
- Reds (hue ~25) can reach higher chroma (~0.22 in sRGB) at mid-lightness
- Yellows/ambers (hue ~70) can reach very high chroma (~0.20+) at mid-lightness

CSS will automatically gamut-map out-of-range values, but the result may not be what
you intended. Better to stay within gamut by design.

### Token Naming Convention

Following Polaris and Radix patterns, the recommended token structure:

```
--color-{semantic}-{element}[-{modifier}]

Examples:
--color-success-surface
--color-success-surface-hover
--color-success-border
--color-success-border-subtle
--color-success-fill
--color-success-icon
--color-success-text
--color-success-text-on-fill
--color-warning-surface
--color-destructive-fill
```

This mirrors the existing Meridian token pattern and the Polaris distinction between
`bg-surface` (large area, muted) and `bg-fill` (small area, vivid).

### Warning on Warm Paper: Special Handling

Warning (amber, hue 70) is closest to the background hue (85). This means:

1. Warning tinted surfaces will have lower contrast against the paper than
   success or destructive tinted surfaces
2. Increase chroma slightly for warning surfaces to compensate (0.035 vs 0.030
   for others)
3. Consider using a slightly darker surface L value for warning (0.935 vs 0.940)
4. Always pair warning color with an icon -- never rely on the background tint alone
5. Test warning surfaces against the paper background specifically, not just in
   isolation

### Contrast Validation Checklist

For each semantic color, validate these pairings:

- [ ] `{semantic}-text` on page background: >= 4.5:1 (AA)
- [ ] `{semantic}-text` on `{semantic}-surface`: >= 4.5:1 (AA)
- [ ] `{semantic}-text-on-fill` on `{semantic}-fill`: >= 4.5:1 (AA)
- [ ] `{semantic}-icon` on page background: >= 3:1 (1.4.11)
- [ ] `{semantic}-border` on page background: >= 3:1 (1.4.11)
- [ ] `{semantic}-surface` is visually distinguishable from page background
- [ ] `{semantic}-fill` is visually distinguishable from other semantic fills

---

## 10. Key Takeaways

1. **OKLCH perceptual uniformity is the key advantage**: Set the same L value across
   success, warning, and destructive for each role tier and get visually equivalent
   weight. No manual per-hue adjustments needed (unlike HSL).

2. **Warm-shift hues toward the background, but within limits**: Success can move
   from 150 to ~145 (still clearly green). Warning at 70 (amber-orange) is inherently
   warm. Destructive at 25 (vermillion) is already warm. Do not push success below
   hue 120 or it becomes chartreuse.

3. **Keep semantic chroma proportional to the surface**: Backgrounds get 3-8x the
   surface chroma. Fills get 15-25x. This prevents semantic colors from screaming
   against the quiet paper.

4. **Separate brand accent from success**: If the accent is jade-teal (hue ~170),
   use a warmer green (hue ~145) for success. The 25-degree gap is enough to
   differentiate in context while keeping both in the green family.

5. **Warning on warm paper needs extra care**: Amber (hue 70) is only 15 degrees
   from the background hue. Boost chroma slightly and always pair with an icon.

6. **Badge fills live in the L 0.45-0.55 range**: Below 0.65 for white text, above
   0.45 for enough contrast with the page background. This is a tight window -- test
   carefully.

7. **Follow the Radix/Polaris pattern**: Each semantic color needs a full ramp from
   surface (subtle) to text (vivid), not just one value. Plan for 7-8 tokens per
   semantic color.

---

## Sources

- [OKLCH in CSS: why we moved from RGB and HSL -- Evil Martians](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl)
- [Better dynamic themes in Tailwind with OKLCH -- Evil Martians](https://evilmartians.com/chronicles/better-dynamic-themes-in-tailwind-with-oklch-color-magic)
- [Designing semantic colors for your system -- Imperavi](https://imperavi.com/blog/designing-semantic-colors-for-your-system/)
- [Composing a color palette -- Radix Colors](https://www.radix-ui.com/colors/docs/palette-composition/composing-a-palette)
- [Aliasing -- Radix Colors](https://www.radix-ui.com/colors/docs/overview/aliasing)
- [Color -- Radix Themes](https://www.radix-ui.com/themes/docs/theme/color)
- [How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [A calmer interface for a product in motion -- Linear](https://linear.app/now/behind-the-latest-design-refresh)
- [Palettes and roles -- Shopify Polaris](https://polaris-react.shopify.com/design/colors/palettes-and-roles)
- [Colors -- Vercel Geist](https://vercel.com/geist/colors)
- [Notion Colors: All Hex Codes -- Matthias Frank](https://matthiasfrank.de/en/notion-colors/)
- [About OKLCH -- anxndsgn](https://www.anxndsgn.com/en/writing/oklch)
- [APCA in a Nutshell](https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html)
- [Understanding SC 1.4.11: Non-text Contrast -- W3C](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html)
- [Understanding SC 1.4.3: Contrast Minimum -- W3C](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)
- [Naming colors in design systems -- Adobe](https://adobe.design/stories/design-for-scale/naming-colors-in-design-systems)
- [Approximating contrast-color() with CSS -- CSS-Tricks](https://css-tricks.com/approximating-contrast-color-with-other-css-features/)
- [Falling for OKLCH -- Smashing Magazine](https://www.smashingmagazine.com/2023/08/oklch-color-spaces-gamuts-css/)
- [Atlassian Design: Color](https://atlassian.design/foundations/color/)
- [Tailwind CSS v4 OKLCH Colors](https://tailwindcolor.com/)
