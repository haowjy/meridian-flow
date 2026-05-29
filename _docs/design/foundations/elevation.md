# Elevation

Elevation in Meridian is intentionally minimal. The "paper aesthetic" uses
surface color layering (canvas → card → popover) to establish depth, not
heavy shadows. Elevation tokens convert ad-hoc shadow values into a canonical,
token-first scale.

---

## Design Intent

Meridian follows a **border-first, near-zero-elevation** philosophy:

1. **Surface layers, not shadow layers.** Depth is established by warm color
   progression (canvas → sidebar → card → popover), each layer slightly lighter
   in Paper and slightly lighter in Espresso. This is the primary depth cue.
2. **Shadows are gentle punctuation.** Shadows appear only where elevation
   truly needs spatial emphasis — floating toolbars, dialogs, dropdowns.
3. **No shadow on hover states.** Hover uses background-color changes only.
   The panel resize handle tints on hover but casts no shadow.

*Evidence: Calm writing interfaces (iA Writer, Ulysses, Bear) achieve depth
through color and subtle borders, not layered shadows. Apple's HIG recommends
minimal shadow use for content-focused apps.*

---

## Elevation Token Scale

| Token | Value | Px equivalent | Use |
|---|---|---|---|
| `--elevation-none` | `none` | — | Default surface: canvas, sidebar, card, and the *popover surface color layer* (the warm tint — distinct from the floating Popover component, which lifts; see Shadow Usage Map) |
| `--elevation-subtle` | `0 1px 3px oklch(0 0 0 / 4%)` | 1px / 3px | Composer edge separation, tooltip |
| `--elevation-overlay` | `0 4px 12px oklch(0 0 0 / 10%)` | 4px / 12px | Floating toolbars, dropdowns, command palette |

**Why only three levels:**
- Most surfaces in Meridian use `elevation-none` — depth comes from color.
- `elevation-subtle` is the ceiling for in-canvas floating elements.
- `elevation-overlay` is reserved for true overlay surfaces (dialogs, sheets).
  Dialogs additionally use a backdrop (`oklch(0 0 0 / 50%)` in Paper,
  `oklch(0 0 0 / 60%)` in Espresso) for focus trapping.

---

## Shadow Usage Map

Every shadow in the product must use an elevation token. No ad-hoc
`box-shadow` values.

| Component | Token | Notes |
|---|---|---|
| Composer | `--elevation-subtle` | Separates composer from turns above |
| Tooltip | `--elevation-subtle` | Subtle lift from background |
| Hunk action widget | `--elevation-overlay` | Floating above editor content |
| ProposalReviewToolbar | `--elevation-overlay` | Floating at bottom of editor |
| Formatting toolbar | `--elevation-overlay` | Floating above text selection |
| Popover | `--elevation-overlay` | Transient floating overlay — same interaction class as menus; lifts off the canvas |
| DropdownMenu | `--elevation-overlay` | Popover menu |
| ContextMenu | `--elevation-overlay` | Right-click menu |
| Command palette | `--elevation-overlay` | Plus backdrop |
| Dialog | `--elevation-none` (use backdrop) | Dialog itself uses border + backdrop |
| Sheet | `--elevation-none` (use backdrop) | Sheet itself uses border + backdrop |
| Toast (sonner) | `--elevation-overlay` | Stacked notifications |
| AccessoryBar | `--elevation-subtle` | Separates from keyboard below |
| HunkReviewSheet | `--elevation-overlay` | Floating review sheet |

---

## Implementation

```css
:root {
  --elevation-none: none;
  --elevation-subtle: 0 1px 3px oklch(0 0 0 / 4%);
  --elevation-overlay: 0 4px 12px oklch(0 0 0 / 10%);
}

.dark {
  --elevation-subtle: 0 1px 3px oklch(0 0 0 / 15%);
  --elevation-overlay: 0 4px 12px oklch(0 0 0 / 25%);
}
```

Components consume these via Tailwind utilities:

```css
/* Composer */
box-shadow: var(--elevation-subtle);

/* Proposals toolbar */
box-shadow: var(--elevation-overlay);
```

---

## What Elevation Is NOT Used For

The following elements explicitly use **no shadow** (only borders and
background-color for depth):

- Rail — right border only
- Tab bar — bottom border only
- File explorer — right border only
- Status bar — top border only
- Cards — `1px border` + `radius-lg`
- Buttons — border + background-color on hover
- Inputs — border
- Hover states — background-color change only
- Active indicators — accent color, no shadow
- Focus ring — outline, no shadow
