# Typography

Typography does most of the visual work in Meridian. Size, weight, and spacing
create hierarchy — not color fills, borders, or heavy chrome.

---

## Font Roles

Three fonts, three jobs. No mixing.

| Role | Font | Stack | Use |
|---|---|---|---|
| **UI** | Geist Variable | `'Geist Variable', ui-sans-serif, system-ui, sans-serif` | Navigation, labels, buttons, badges, metadata, tool chrome |
| **Prose** | iA Writer Quattro | `'iA Writer Quattro', 'Georgia', serif` | Editor content, rendered markdown, conversation turn text, document preview |
| **Code** | Geist Mono Variable | `'Geist Mono Variable', ui-monospace, monospace` | Inline code, code blocks, file paths, keyboard shortcuts, terminal output, tool arguments |

**Why this split:**
- Geist is designed for legibility and simplicity in UI contexts — clean, modern,
  technically precise.
- iA Writer Quattro is optimized for long-form prose reading — monospaced
  punctuation, generous word spacing, high x-height, serene reading rhythm.
- Geist Mono is crafted for code editors and terminals — clear character
  distinction, compact, professional.

*Evidence: iA's own research shows that prose-optimized fonts with carefully
designed spacing create a better long-form reading experience than UI-optimized
sans-serifs (design-language-best-practices §2).*

### Installed Weights

| Font | Weights | Notes |
|---|---|---|
| Geist Variable | Variable (100–900) | Use 400 (regular), 500 (medium), 600 (semibold) |
| iA Writer Quattro | 400, 400i, 700, 700i | Regular + bold, each with italic |
| Geist Mono Variable | Variable (100–900) | Use 400 (regular), 500 (medium) |

**Weight discipline:** Limit visible weights to 3–4 per font. Excessive weight
variation creates visual noise. For UI: regular (body), medium (labels,
emphasis), semibold (headings, action text). For prose: regular (body), bold
(strong emphasis). For code: regular only.

---

## Type Scale

Eight fluid sizes using `clamp()`. No fixed breakpoint jumps — sizes
interpolate smoothly across viewport widths.

| Token | Min | Preferred | Max | Px range | Primary use |
|---|---|---|---|---|---|
| `--text-xs` | 0.6875rem | 0.65rem + 0.1vw | 0.75rem | 11–12 | Micro labels, status bar, timestamps |
| `--text-sm` | 0.8125rem | 0.78rem + 0.12vw | 0.875rem | 13–14 | Secondary UI, sidebar items, captions |
| `--text-base` | 0.9375rem | 0.9rem + 0.15vw | 1rem | 15–16 | Primary UI text, form labels |
| `--text-lg` | 1.0625rem | 1rem + 0.2vw | 1.125rem | 17–18 | Emphasized UI text |
| `--text-xl` | 1.1875rem | 1.1rem + 0.28vw | 1.25rem | 19–20 | Section headings |
| `--text-2xl` | 1.375rem | 1.25rem + 0.4vw | 1.5rem | 22–24 | Page headings (H2) |
| `--text-3xl` | 1.75rem | 1.5rem + 0.6vw | 1.875rem | 28–30 | Primary headings (H1) |
| `--text-4xl` | 2rem | 1.7rem + 0.8vw | 2.25rem | 32–36 | Display (rare) |

**Scale discipline:** Most screens should use at most 4 of these sizes. A calm
writing interface doesn't need many sizes — restraint creates rhythm.

*Evidence: Material and Web Typography guidance recommend a modest, related set
of sizes; too many sizes wreck a layout (design-language-best-practices §2).*

### Fluid Scale Guardrails (clamp() & Zoom Accessibility)

The fluid `clamp()` type scale carries a real WCAG 1.4.4 (Resize Text) risk:
viewport-driven text can suppress the user's own zoom and font-size preference.
These guardrails prevent that.

*Evidence: research `web-typography-systems.md` — web.dev fluid-type guidance
([Responsive and fluid typography](https://web.dev/articles/baseline-in-action-fluid-type), published 2025-12-16), W3C SC 1.4.4
([Understanding Resize Text](https://w3c.github.io/wcag/understanding/resize-text.html)), Utopia `clamp()` cautions
([Clamp](https://utopia.fyi/blog/clamp/), first published 2020-09-25).*

> **Decision:** All `clamp()` min and max bounds are expressed in **`rem` or
> `em`, never `px`**. The maximum size is at most **2.5× the minimum size**
> for any given token. Viewport influence (the `vw` middle term) is kept
> modest, and the range is bounded conservatively. Behavior at **200% zoom**
> and **text-only resize** is an explicit QA gate.
>
> **Rationale:** web.dev's 2025 guidance is direct: "the more text responds
> to the viewport, the less it responds to user preferences" and viewport-only
> font sizing is dangerous for WCAG 1.4.4 compliance. Using `rem`/`em` bounds
> keeps the system anchored to the user's root font-size preference. The 2.5×
> max/min ratio is a conservative rule of thumb that preserves 200% resize
> behavior in modern browsers ([web.dev fluid type](https://web.dev/articles/baseline-in-action-fluid-type)). Testing at 200% zoom + text-only
> resize catches the failure modes WCAG 1.4.4 warns about: clipping, overlap,
> and single-word vertical columns ([W3C SC 1.4.4](https://w3c.github.io/wcag/understanding/resize-text.html)).
>
> **Rejected:** Using `px` for clamp bounds — decouples the scale from the
> user's font preference and can silently defeat browser zoom. Using
> aggressive `vw` terms or wide ranges — creates a system where large screens
> flatten user control and small screens become illegible.

**Verification of the current scale against the 2.5× rule:**

| Token | Min (rem) | Max (rem) | Ratio | Pass? |
|---|---|---|---|---|
| `--text-xs` | 0.6875 | 0.75 | 1.09× | ✓ |
| `--text-sm` | 0.8125 | 0.875 | 1.08× | ✓ |
| `--text-base` | 0.9375 | 1.0 | 1.07× | ✓ |
| `--text-lg` | 1.0625 | 1.125 | 1.06× | ✓ |
| `--text-xl` | 1.1875 | 1.25 | 1.05× | ✓ |
| `--text-2xl` | 1.375 | 1.5 | 1.09× | ✓ |
| `--text-3xl` | 1.75 | 1.875 | 1.07× | ✓ |
| `--text-4xl` | 2.0 | 2.25 | 1.13× | ✓ |

All eight tokens pass comfortably. The current scale is conservative by design.

**Reinforced rule:** The 8-size scale is a **token vocabulary**, not a
per-screen menu. The existing ≤4-sizes-per-screen rule stands and is well
supported externally — Material, IBM, and Apple all converge on a small
subset of related sizes per surface. The scale exists so every size the
system *does* use is part of a single harmonic set.

---

## UI Typography

All non-editor, non-prose chrome uses Geist.

### Line Heights

| Context | Line-height | Rationale |
|---|---|---|
| Compact chrome (labels, badges, tabs) | 1.25 | Dense, space-efficient |
| Default body (paragraphs, descriptions) | 1.5 | Comfortable reading |
| Relaxed (larger headings) | 1.35 | Headings need less leading |

### Common Patterns

| Element | Size | Weight | Additional |
|---|---|---|---|
| Rail tooltip | `text-xs` | 500 (medium) | — |
| Status bar | `text-xs` | 400 | `muted-foreground` |
| Tab label | `text-sm` | 500 (medium) | — |
| File explorer item | `text-sm` | 400 (regular), 500 (active) | — |
| Sidebar section header | `text-xs` | 600 (semibold) | Uppercase, `tracking-wider` |
| Button label | `text-sm` | 500 (medium) | — |
| Form label | `text-sm` | 500 (medium) | — |
| Form helper text | `text-xs` | 400 | `muted-foreground` |
| Card title | `text-base` | 600 (semibold) | — |
| Dialog title | `text-lg` | 600 (semibold) | — |
| Page heading | `text-2xl` | 600 (semibold) | — |
| Turn timestamp | `text-xs` | 400 | `muted-foreground` |
| Tool block label | `text-sm` | 500 (medium) | `font-mono` for paths/commands |
| Badge | `text-xs` | 500 (medium) | — |
| Keyboard shortcut | `text-xs` | 400 | `font-mono`, muted bg chip |

---

## Prose / Editor Typography

iA Writer Quattro in the editor. The editor surface is the product's primary
reading and writing experience — typography here matters more than anywhere
else.

### Editor Tokens

| Token | Value | Notes |
|---|---|---|
| `--editor-font-size` | `clamp(1rem, 0.95rem + 0.2vw, 1.125rem)` | 16–18px range |
| `--editor-measure` | `68ch` | Content column width. iA Writer standard. |
| `--editor-leading` | `1.65` | Line-height. Generous for long-form reading. |
| `--editor-paragraph-spacing` | `1em` | Space between paragraphs. Clearly larger than intra-paragraph leading. |

**Rationale for 68ch:** The comfortable reading range is 45–75 characters with
a sweet spot around 60–72ch. 68ch is the iA Writer standard and provides a
natural prose rhythm at the editor's font size.

*Evidence: Web Typography, Baymard, and Material guidance all converge on
~60–72ch as optimal measure (design-language-best-practices §2).*

### Heading Scale in Editor

Headings in the editor are rendered by live-preview decorations (see
`interaction/editor.md`). They use iA Writer Quattro at these relative sizes:

| Level | Size multiplier | Weight | Line-height | Spacing above |
|---|---|---|---|---|
| H1 | 1.5em | 700 | 1.35 | 1.5em |
| H2 | 1.3em | 700 | 1.35 | 1.25em |
| H3 | 1.15em | 700 | 1.4 | 1em |
| H4 | 1em | 700 | 1.5 | 0.75em |
| H5 | 1em | 600 | 1.5 | 0.75em |
| H6 | 0.9em | 600 | 1.5 | 0.75em |

### Editor Code Blocks

Fenced code blocks inside the editor use Geist Mono:

| Property | Value |
|---|---|
| Font | Geist Mono Variable |
| Size | 0.92em (relative to editor base) |
| Line-height | 1.5 |
| Background | `muted` surface |
| Border-radius | `radius-lg` |
| Padding | `padding-default` |

### Prose in Conversation Turns

Conversation turn content (assistant responses, user messages) also uses
iA Writer Quattro at `text-base` size with `1.6` line-height. This keeps the
reading experience consistent between the editor and the conversation surface.

**Exception:** Tool block content, code snippets, and structured metadata in
turns use their appropriate fonts (Geist Mono for code, Geist for UI labels).

---

## Code Typography

Geist Mono for all literal/technical content.

### Code Contexts

| Context | Size | Additional |
|---|---|---|
| Inline code | 0.9em (relative to surrounding text) | `muted` bg, `radius-sm` padding |
| Code block in editor | 0.92em (relative to editor base) | See above |
| Tool arguments in activity stream | `text-sm` | `muted` bg |
| File path in tool header | `text-sm` | Truncate with ellipsis from left |
| Terminal output | `text-sm` | `muted` bg, preserve whitespace |
| Keyboard shortcut chip | `text-xs` | `border`, `muted` bg, `radius-sm` |

---

## Accessibility

### Minimum Sizes

- No text below 11px rendered size (the floor of `text-xs` clamp).
- Interactive text (buttons, links, form labels) should be at minimum `text-sm`
  (13px+).
- User preference `font-size` on `<html>` scales the entire system via `rem`
  units.

### Contrast Requirements

All text must meet WCAG AA (4.5:1 for normal text, 3:1 for large text).
See `color.md` for specific pairings and contrast ratios.

### Reduced Motion

The fluid type scale uses `vw` for smooth interpolation. This is not
animation — no `prefers-reduced-motion` consideration needed for type sizing.
