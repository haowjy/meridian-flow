# Meridian Design System Implementation

**Jade & Gold Theme - Implementation Guide**

This document describes the complete Meridian design system implementation based on `_docs/high-level/design.md`.

---

## Overview

The Meridian Jade & Gold design system has been fully implemented throughout the frontend using Tailwind CSS v4's CSS-first configuration approach with OKLCH color space.

**Design Philosophy**: Maximize workspace for long-form writing — compact chrome, comfortable content, consistent typography across “front” pages and the workspace.

---

## Color System

### Light Mode - "Morning study: parchment warmth, calm focus"

**Primary Colors:**
- **Jade** (`--jade-500`): `#A9BDB5` → Primary UI color for structure
- **Gold** (`--gold-500`): `#F4B41A` → Accent color for highlights & actions
- **Parchment** (`--parchment`): `#F7F3EB` → Warm background
- **Ink** (`--ink`): `#1C1A18` → Text color

**Interactive States:**
- Hover: Lighter jade (`--jade-400`)
- Active: Darker jade (`--jade-600`)
- Focus: 3px gold ring with 2px offset
- Disabled: 40% opacity

### Dark Mode - "Evening chamber: luminous jade over soft shadow"

**Primary Colors:**
- **Jade Black** (`--jade-dark-500`): `#1B2421` → Deep green-black base
- **Gold Warm** (`--gold-warm-500`): `#E3C169` → Enhanced luminosity
- **Charcoal Parchment** (`--charcoal`): `#202622` → Dark workspace
- **Ink Light** (`--ink-dark`): `#EAEAE7` → Light text

### Semantic Colors

- **Success**: Jade-tinted green for confirmations
- **Warning**: Amber tones for alerts
- **Error**: Amber (same as warning)
- **Info**: Light jade for informational messages

---

## Typography

### Fonts

**Primary (Serif)** - Literata
- Usage: Editor content, chat messages, section headers, brand
- Weights: Regular (400), Medium (500), Bold (700)
- Loaded via Next.js font optimization from Google Fonts

**Secondary (Sans-serif)** - Inter
- Usage: Buttons, UI controls, labels, metadata
- Weights: Regular (400), Medium (500), Bold (700)
- Loaded via Next.js font optimization from Google Fonts

### Scale

| Element | Size | Weight | Line Height | Font |
|---------|------|--------|-------------|------|
| Brand/Logo | 20-22px | Bold | 1.3 | Literata |
| H1 / Display | 20px | Semibold | 1.3 | Literata |
| H2 / Section | 18px | Semibold | 1.35 | Literata |
| Body Text | 15-16px | Regular | 1.5 | Literata |
| UI Labels | 13-14px | Medium | 1.4 | Inter |
| Metadata | 12-13px | Regular | 1.4 | Inter |

Guidelines:
- Keep headings compact to preserve vertical space; avoid large hero-style titles.
- Make body text the anchor: Literata 15–16px with ~1.5 line-height for all long-form reading (editor, chat, front pages).
- Use a single shared scale for “front” views (projects, lists) and the workspace so typography feels identical while exploring and writing.

---

## Design Tokens

### Border Radius

```css
--radius-sm: 6px    /* Small controls (inputs, icons) */
--radius: 8px       /* Primary default (buttons, cards, list rows) */
--radius-md: 10px   /* Transitional / special cases */
--radius-lg: 12px   /* Large containers (panels, messages, empty/error states) */
--radius-xl: 16px   /* Extra large elements */
```

Guidelines:
- Prefer rounded corners for most surfaces; sharp corners should be rare.
- Use `--radius` (8px) by default, `--radius-sm` (6px) when space is tight, and `--radius-lg` (12px) for major containers and bubbles where you want a softer, more “workspace” feel.

### Spacing (8pt Grid)

```css
--spacing-1: 4px
--spacing-2: 8px
--spacing-3: 16px
--spacing-4: 24px   /* Minimum outer margins */
--spacing-5: 32px
--spacing-6: 48px
```

### Shadows (Jade-tinted)

```css
--shadow-xs: Minimal (form inputs)
--shadow-sm: 2dp (hover states, cards)
--shadow-md: 4dp (popovers, dropdowns)
--shadow-lg: 8dp (modals, dialogs)
```

All shadows have subtle jade tint for visual cohesion.

### Opacity Scale

```css
--opacity-disabled: 0.4
--opacity-hover: 0.8
--opacity-overlay: 0.6
--opacity-subtle: 0.2
```

### Animation

```css
--duration-fast: 150ms
--duration-medium: 200ms
--duration-slow: 250ms
--easing-default: cubic-bezier(0.4, 0, 0.2, 1)
```

---

## Component Guidelines

### Buttons

- **Variants**:
  - `default`: Jade background, white text
  - `accent`: Gold background, dark text
  - `destructive`: Amber for warnings/errors
  - `outline`: Border with jade/gold accents
  - `ghost`: Minimal with jade hover
  - `link`: Jade text, gold on hover

- **States**:
  - Hover: Jade tint
  - Focus: 3px gold outline with 2px offset
  - Disabled: 40% opacity

### Cards

- Background: Parchment tones
- Border: Subtle jade
- Radius: 8px (`--radius`)
- Shadow: Small (`--shadow-sm`)

### Inputs

- Background: Parchment
- Border: Light border color
- Focus: Gold outline (3px with 2px offset)
- Radius: 6px (`--radius-sm`)

### Dialogs & Modals

- Overlay: Background with 60% opacity + backdrop blur
- Content: Parchment background, jade border
- Radius: 12px (`--radius-lg`)
- Shadow: Large (`--shadow-lg`)

### Chat Messages

**Design Spec**: 10-12px rounded corners, gentle elevation on hover

- **User Messages**: Soft parchment fill, right-aligned
- **AI Messages**: Jade outline, left-aligned
- **Hover**: Subtle shadow elevation (--shadow-sm)
- **Radius**: 12px (`--radius-lg`)

### Tooltips

- Background: Parchment
- Border: 1px jade
- Shadow: Small
- Font: Inter, 13px

### Progress Bars

- Track: Jade at 20% opacity
- Fill: Gold accent
- Height: 4px
- Radius: 8px (rounded)

### Badges/Tags

- Background: Jade at 10% opacity
- Border: Jade subtle
- Text: Jade foreground color
- Radius: 12px (`--radius-lg`)

---

## Implementation Details

### File Structure

```
frontend/src/
├── app/
│   ├── layout.tsx           # Google Fonts setup (Literata + Inter)
│   └── globals.css          # Complete design system definition
├── shared/components/ui/    # Updated component library
│   ├── button.tsx          # Jade/gold variants
│   ├── card.tsx            # Parchment backgrounds
│   ├── input.tsx           # Gold focus rings
│   ├── dialog.tsx          # Modal styling
│   ├── dropdown-menu.tsx   # Jade hover states
│   ├── switch.tsx          # Updated tokens
│   ├── label.tsx           # Inter font
│   └── StatusBadge.tsx     # Semantic color mapping
└── features/
    └── chats/              # Already compatible (uses semantic tokens)
```

### Tailwind v4 Approach

The implementation uses Tailwind CSS v4's new CSS-first configuration:

1. **No `tailwind.config.js`** - All configuration in `globals.css`
2. **`@theme inline` directive** - Makes CSS variables available as utilities
3. **OKLCH color space** - Perceptually uniform colors
4. **CSS variables** - Easy theme swapping

### Theme Swapping

To create alternative themes:

```css
/* In globals.css */
[data-theme="alternative-name"] {
  --jade-primary: /* custom jade */;
  --gold-accent: /* custom gold */;
  /* ... override other primitive colors */
}
```

Then apply via:

```tsx
<html data-theme="alternative-name">
```

All components use semantic tokens, so swapping themes only requires changing primitive color definitions.

---

## Custom CSS Classes

### Chat Components

```css
.chat-pane              /* Sidebar with jade background */
.chat-pane-header       /* Header with jade border */
.chat-pane-body         /* Content area */
.chat-list-item         /* Individual chat items */
.chat-list-item--active /* Active chat (gold highlight) */
.chat-message           /* Base message style */
.chat-message--user     /* User message (parchment) */
.chat-message--ai       /* AI message (jade outline) */
```

### Editor Components

```css
.tiptap                 /* Editor wrapper (parchment + Literata) */
.tiptap-toolbar         /* Toolbar with jade/gold accents */
.ProseMirror            /* Content area (Literata font) */
.ProseMirror h1-h6      /* Heading styles with Literata */
.ProseMirror a          /* Links: jade → gold on hover */
.ProseMirror mark       /* Highlights: gold background */
```

---

## Accessibility

### Contrast Ratios

All text/background combinations meet **WCAG AA** requirements (4.5:1 minimum):

- ✅ Ink on Parchment: High contrast
- ✅ White on Jade: High contrast
- ✅ Gold accents: Verified for both modes
- ✅ Success/Warning/Error: Sufficient contrast

### Focus States

- **Visible focus indicators**: 3px gold outline with 2px offset
- **Keyboard navigation**: All interactive elements focusable
- **Screen readers**: Semantic HTML + ARIA labels
- **Color independence**: Never rely on color alone for meaning

### Dark Mode

- Smooth color inversion without jarring transitions
- Maintained contrast ratios throughout
- Gold accent remains visible and distinguishable
- Jade-tinted shadows adjust for dark backgrounds

---

## Usage Examples

### Using Design Tokens in Components

```tsx
// Button with jade background and gold focus
<button className="bg-primary text-primary-foreground hover:bg-hover
                   focus-visible:outline-[3px] focus-visible:outline-accent
                   rounded-[--radius] shadow-[--shadow-sm]">
  Click me
</button>

// Card with parchment background
<div className="bg-card border-border rounded-[--radius] shadow-[--shadow-sm]">
  Card content
</div>

// Input with gold focus ring
<input className="bg-background border-input rounded-[--radius-sm]
                  focus-visible:outline-accent" />
```

### Using Semantic Colors

```tsx
// Success message
<div className="text-success bg-success/10 border-success">
  Operation successful
</div>

// Warning badge
<span className="text-warning bg-warning/10 border-warning">
  Pending sync
</span>
```

### Typography

```tsx
// Literata for content
<div className="font-serif text-base leading-relaxed">
  Long-form writing content...
</div>

// Inter for UI
<label className="font-sans text-sm font-medium">
  Document Title
</label>
```

---

## Best Practices

1. **Always use semantic tokens** - Never hardcode colors
2. **Use CSS variable syntax** - `rounded-[--radius]` not `rounded-md`
3. **Apply proper fonts** - `font-serif` for content, `font-sans` for UI
4. **Maintain 8pt grid** - Use spacing tokens for consistency
5. **Test dark mode** - Verify all components in both themes
6. **Check contrast** - Ensure WCAG AA compliance
7. **Use transitions** - Apply duration tokens for smooth interactions

---

## Testing Checklist

- ✅ Light mode: All components use parchment/jade/gold palette
- ✅ Dark mode: Colors invert smoothly, contrast maintained
- ✅ Typography: Literata for content, Inter for UI
- ✅ Focus states: Gold outlines visible on all interactive elements
- ✅ Hover states: Jade tints apply consistently
- ✅ Shadows: Jade-tinted, appropriate elevation
- ✅ Accessibility: WCAG AA contrast ratios met
- ✅ Theme swapping: Semantic tokens allow easy customization

---

## Future Enhancements

Potential additions to the design system:

1. **Additional theme presets** - "Ocean Blue", "Forest Green" variants
2. **User customization** - Hue adjustment while maintaining structure
3. **High contrast mode** - Enhanced accessibility option
4. **Reduced motion** - Respect `prefers-reduced-motion`
5. **Custom scrollbars** - Styled to match jade/gold theme
6. **Loading states** - Gold shimmer animations
7. **Microinteractions** - Subtle jade/gold transitions

---

## Resources

- **Design Specification**: `_docs/high-level/design.md`
- **Tailwind v4 Docs**: https://tailwindcss.com/docs
- **OKLCH Color Space**: https://oklch.com
- **shadcn/ui Theming**: https://ui.shadcn.com/docs/theming
- **Next.js Font Optimization**: https://nextjs.org/docs/app/building-your-application/optimizing/fonts

---

**Version**: 1.0
**Last Updated**: 2025-11-16
**Status**: ✅ Fully Implemented
