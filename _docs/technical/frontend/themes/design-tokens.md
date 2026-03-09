---
detail: minimal
audience: developer
---

# Design Tokens Reference

All tokens defined in `frontend/src/globals.css` under `@theme inline`. Theme-specific colors in `themes/`.

## Component Heights

| Token | Pixels | Tailwind | Use |
|-------|--------|----------|-----|
| `--component-height-xs` | 24px | h-6 | Compact icon buttons |
| `--component-height-sm` | 32px | h-8 | Small buttons |
| `--component-height-md` | 36px | h-9 | Default buttons/inputs |
| `--component-height-lg` | 40px | h-10 | Auth forms, prominent actions |

## Spacing (8pt Grid)

| Token | Value |
|-------|-------|
| `--spacing-1` | 4px |
| `--spacing-2` | 8px |
| `--spacing-3` | 16px |
| `--spacing-4` | 24px |
| `--spacing-5` | 32px |
| `--spacing-6` | 48px |

## Border Radius

| Token | Value |
|-------|-------|
| `--radius-sm` | 6px |
| `--radius` | 8px |
| `--radius-md` | 10px |
| `--radius-lg` | 12px |
| `--radius-xl` | 16px |

Tailwind `rounded-sm` is 4px, not 6px. Use `rounded-[--radius-sm]` for 6px, or `rounded` (8px) for most cases.

## Panel Layout

| Token | Value |
|-------|-------|
| `--workspace-rail-width` | 48px |
| `--panel-header-height` | 3rem (48px) |
| `--thread-composer-max-height` | 240px |
| `--mobile-top-header-height` | 56px |
| `--mobile-bottom-bar-height` | 48px |

## Shadows

Three elevation levels with theme-aware warm tinting (`--theme-shadow-*`):

| Token | Use |
|-------|-----|
| `--shadow-1` | Cards, list items |
| `--shadow-2` | Dropdowns, popovers |
| `--shadow-3` | Modals |

Usage: `className="shadow-[var(--shadow-1)]"`

## Focus Rings

Applied globally via `globals.css` to interactive elements on `:focus-visible`. Opacity tokens: `--focus-outer-opacity: 0.28`, `--focus-inner-opacity: 0.12`.

## Animation

| Token | Value | Use |
|-------|-------|-----|
| `--duration-fast` | 150ms | Hover, micro-interactions |
| `--duration-medium` | 200ms | Standard transitions |
| `--duration-slow` | 250ms | Larger animations |
| `--easing-default` | cubic-bezier(0.4, 0, 0.2, 1) | Default easing |

## Opacity

| Token | Value | Use |
|-------|-------|-----|
| `--opacity-disabled` | 0.6 | Disabled state |
| `--opacity-hover` | 0.08 | Hover overlay |
| `--opacity-overlay` | 0.6 | Modal backdrops |
| `--opacity-subtle` | 0.2 | Subtle decorations |

## Typography

| Stack | Token | Fonts |
|-------|-------|-------|
| Display/Body | `--font-display`, `--font-body` | Source Serif 4, Georgia, serif |
| UI | `--font-ui` | Inter, system-ui, sans-serif |
| Mono | `--font-mono` | JetBrains Mono, ui-monospace, ... |

### Utility Classes

| Class | Font | Size | Weight |
|-------|------|------|--------|
| `.type-display` | serif | 20px | semibold |
| `.type-section` | serif | 18px | semibold |
| `.type-body` | serif | 15px | normal |
| `.type-label` | sans | 13px | medium |
| `.type-meta` | sans | 12px | normal |

Mobile (< 768px): `.type-body` 18px, `.type-label` 15px, `.type-meta` 14px.

## See Also

- `README.md` -- Theme system and color values
- `tailwind-strategies.md` -- When to use each styling approach
- `globals.css` -- Source definitions
