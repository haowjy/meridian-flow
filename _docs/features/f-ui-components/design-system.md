---
stack: frontend
status: complete
feature: "Design System"
---

# Design System

**shadcn/ui component library (Radix UI + Tailwind CSS).**

## Status: ✅ Complete

---

## Components

**Location**: `frontend/src/shared/components/ui/`

**Installed** (18 components):
- Alert Dialog, Button, Card, Checkbox, Collapsible
- Context Menu, Dialog, Dropdown Menu, Hover Card
- Input, Label, Resizable, Scroll Area, Switch
- Textarea, Tooltip
- **Custom**: CompactBreadcrumb, StatusBadge

**Source**: https://ui.shadcn.com/

## Component Details

### Button

**Variants**: `default`, `destructive`, `outline`, `ghost`, `link`, `primary`

**Color Migration (v3)**: `accent` variant renamed to `primary` - uses sage green (`--theme-primary`)

### Label

**Variants**:
- `default` - Standard form label
- `editorial` - Uppercase with wide letter spacing (for section headers)

### Textarea

**New in h/skills**: Multi-line text input component matching Input styling.

## Color Semantics in Components

Theme v3+ introduces semantic color usage:

**Primary (sage)**: Interactive elements
- Button primary variant
- Focus rings
- Active/selected states

**Favorite (gold)**: Special emphasis
- Stars, bookmarks
- Featured content markers

**Migration from v2**: When updating components that used `accent`:
1. **Interactive element?** → Use `primary`
2. **Special marking?** → Use `favorite`

---

## Styling

**Tailwind CSS**: Utility-first styling
**Theme**: Modern Literary (single theme, no theme switching)
**Dark mode**: Light/dark/system mode toggle available (no UI toggle exposed yet)
**Responsive**: Mobile and desktop support

---

## Related

- See [custom-components.md](custom-components.md) for custom components
