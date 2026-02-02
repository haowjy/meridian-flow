---
stack: frontend
status: complete
feature: "UI Components"
---

# UI Components

**shadcn/ui design system and custom components with high polish.**

## Status: ✅ Complete

---

## Features

**Design System** - shadcn/ui (Radix UI + Tailwind)
- See [design-system.md](design-system.md)

**Custom Components** - TreeItemWithContextMenu, StatusBadge, PanelLayout, etc.
- See [custom-components.md](custom-components.md)

**Loading/Error States** - Skeletons, error boundaries, spinners
- See [loading-error-states.md](loading-error-states.md)

---

## Component Inventory

**Location**: `frontend/src/shared/components/ui/`

| Component | Purpose | Variants | Status |
|-----------|---------|----------|--------|
| Alert Dialog | Modal confirmations | - | ✅ |
| Button | Interactive buttons | default, destructive, outline, ghost, link, primary | ✅ |
| Card | Content containers | - | ✅ |
| Checkbox | Toggle inputs | - | ✅ |
| Collapsible | Expandable sections | - | ✅ |
| Context Menu | Right-click menus | - | ✅ |
| Dialog | Modal dialogs | - | ✅ |
| Dropdown Menu | Action menus | - | ✅ |
| Hover Card | Hover tooltips | - | ✅ |
| Input | Single-line text input | - | ✅ |
| Label | Form labels | default, editorial | ✅ |
| Resizable | Resizable panels | - | ✅ |
| Scroll Area | Custom scrollbars | - | ✅ |
| Switch | Toggle switches | - | ✅ |
| Textarea | Multi-line text input | - | ✅ |
| Tooltip | Hover hints | - | ✅ |
| **Custom:** CompactBreadcrumb | Breadcrumb navigation | - | ✅ |
| **Custom:** StatusBadge | Save status indicator | Saved, Saving, Error | ✅ |

**Total**: 18 components (16 shadcn/ui + 2 custom)

---

## Recent Changes

**Theme v3 Migration** (h/skills branch):
- Button: `accent` variant → `primary` variant (uses sage green)
- Label: Added `editorial` variant (uppercase, tracking-wide)
- Textarea: New component added for multi-line input
- Color semantics: `primary` (sage) for interactive, `favorite` (gold) for special emphasis

---

## Files

**shadcn/ui**: `frontend/src/shared/components/ui/`
**Custom**: `frontend/src/shared/components/`

---

## Polish Level

✅ High polish - Consistent hover states, smooth transitions, responsive design, accessibility

---

## Related

- See shadcn/ui docs: https://ui.shadcn.com/
