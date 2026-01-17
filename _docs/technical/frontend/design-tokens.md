---
title: Design Tokens Reference
description: Comprehensive reference for Meridian's design system tokens
created_at: 2025-01-16
updated_at: 2025-01-16
author: Claude
category: technical
tracked: true
---

# Design Tokens Reference

This document defines the design tokens used throughout Meridian's frontend. For theme-specific values, see `themes/`.

## Component Heights

Consistent height scale for interactive components:

```css
--component-height-xs: 24px;  /* Compact inline controls (icon-xs) */
--component-height-sm: 32px;  /* Small buttons, inputs (h-8) */
--component-height-md: 36px;  /* Default buttons, inputs (h-9) */
--component-height-lg: 40px;  /* Large/prominent, auth forms (h-10) */
```

**Usage:**
```tsx
// Input with large size (auth forms)
<Input size="lg" />

// Custom component using token
<div style={{ height: 'var(--component-height-md)' }} />
```

| Size | Pixels | Tailwind | Use Case |
|------|--------|----------|----------|
| xs | 24px | h-6 | Compact icon buttons |
| sm | 32px | h-8 | Small buttons, tight spaces |
| md | 36px | h-9 | Default buttons and inputs |
| lg | 40px | h-10 | Auth forms, prominent actions |

## Spacing (8pt Grid)

Spacing follows an 8pt grid for visual rhythm:

```css
--spacing-1: 4px;   /* Micro (icon gaps, tight padding) */
--spacing-2: 8px;   /* Standard (within components) */
--spacing-3: 16px;  /* Comfortable (form fields) */
--spacing-4: 24px;  /* Generous (sections) */
--spacing-5: 32px;  /* Large (major divisions) */
--spacing-6: 48px;  /* Extra large (page sections) */
```

Maps to Tailwind: `gap-1` = 4px, `gap-2` = 8px, `p-4` = 16px, etc.

## Border Radius

```css
--radius-sm: 6px;   /* Inputs, small buttons */
--radius: 8px;      /* Default (cards, medium buttons) */
--radius-md: 10px;  /* Medium elements */
--radius-lg: 12px;  /* Large cards, modals */
--radius-xl: 16px;  /* Extra large containers */
```

**Important:** Tailwind's `rounded-sm` is 4px, not 6px. Use `rounded-[--radius-sm]` for 6px, or use `rounded` (8px) for most cases.

## Shadows

Three elevation levels with theme-aware warm tinting:

```css
--shadow-1: /* Subtle - cards, list items */
--shadow-2: /* Medium - dropdowns, popovers */
--shadow-3: /* Prominent - modals */
```

**Usage:**
```tsx
<div className="shadow-[var(--shadow-1)]" />
```

## Focus Rings

Two-layer focus ring system:

```css
--focus-ring-outer: /* 3px outline, ~28% opacity accent */
--focus-ring-inner: /* 2px shadow, ~12% opacity accent */
```

**CSS Utility Classes:**
```css
.focus-ring          /* Standard focus ring (offset 2px) */
.focus-ring-inset    /* Inset focus ring (offset 0) - for inputs */
```

**Usage:**
```tsx
// Most interactive elements get focus rings automatically from globals.css
// For custom elements, use the utility class:
<div className="focus-ring" tabIndex={0}>Custom focusable</div>
```

## Animation

```css
--duration-fast: 150ms;    /* Hover, micro-interactions */
--duration-medium: 200ms;  /* Standard transitions */
--duration-slow: 250ms;    /* Larger animations */
--easing-default: cubic-bezier(0.4, 0, 0.2, 1);
```

## Opacity

```css
--opacity-disabled: 0.6;   /* Disabled state */
--opacity-hover: 0.08;     /* Hover overlay */
--opacity-overlay: 0.6;    /* Modal backdrops */
--opacity-subtle: 0.2;     /* Subtle decorations */
```

---

## Component Patterns

### List Items

Base classes for consistent tree/list items:

```css
.list-item-base      /* Standard sidebar items: gap-2, px-2.5, py-1.5 */
.list-item-compact   /* Dense lists: gap-1.5, px-2, py-1 */
.list-item-action-button  /* "..." menu triggers with responsive sizing */
```

**Usage:**
```tsx
// Standard sidebar list item
<div className="list-item-base group">
  <Icon />
  <span>Item text</span>
  <Button className="list-item-action-button" />
</div>
```

### Panel Headers

Consistent header bars for panels:

```css
.panel-header           /* Standard: px-3, gap-1 */
.panel-header-responsive /* Mobile-first: px-2 sm:px-3, gap-1 */
.panel-header-split     /* Space-between layout */
```

**Usage:**
```tsx
<div className="panel-header" style={{ height: 'var(--editor-header-height)' }}>
  <Button />
  <span className="flex-1">Title</span>
  <Button />
</div>
```

---

## Quick Reference: Button Variants

| Variant | Description | Use Case |
|---------|-------------|----------|
| default | Filled primary | Primary actions |
| accent | Tinted background | Highlighted actions |
| secondary | Outlined | Secondary actions |
| outline | Border only | Tertiary actions |
| ghost | No background | Toolbar icons |
| link | Underlined text | Inline links |
| destructive | Error color | Delete, remove |

| Size | Height | Padding | Use Case |
|------|--------|---------|----------|
| sm | 32px | px-3 | Compact toolbars |
| default | 36px | px-4 | Standard buttons |
| lg | 40px | px-6 | Prominent CTAs |
| icon-xs | 24px | - | Inline icons |
| icon-sm | 28px | - | Small icon buttons |
| icon | 32px | - | Standard icons |
| icon-lg | 36px | - | Large icons |

## Quick Reference: Input Variants

| Size | Height | Use Case |
|------|--------|----------|
| sm | 32px | Compact forms |
| default | 36px | Standard forms |
| lg | 40px | Auth forms, prominent inputs |

---

## See Also

- `themes/README.md` - Theme system and color values
- `tailwind-strategies.md` - When to use each styling approach
- `globals.css` - Source definitions
