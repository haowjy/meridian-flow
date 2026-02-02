---
detail: standard
audience: developer
---

# CollapsibleSidebar Component

**Reusable wrapper for collapsible sidebar panels.**

## Purpose

Presentational component that wraps sidebar content with collapse/expand behavior. Provides consistent styling and behavior for all sidebar panels.

## Props Interface

```typescript
{
  isCollapsed: boolean           // Collapse state (controlled externally)
  width?: number                 // Width in pixels (default: 200)
  side?: 'left' | 'right'        // Which side of screen (default: 'left')
  children: ReactNode            // Sidebar content
}
```

## Behavior

**Collapsed**: `display: none` (completely hidden)
**Expanded**: Fixed width + border separator

**No internal state** - collapse state controlled by parent component.

## Styling

**Width**: Fixed pixel width when expanded
**Border**: Applied on appropriate side (right border for left sidebar, left border for right sidebar)
**Background**: Inherits from theme (`--theme-sidebar`)

## Usage Pattern

```typescript
<CollapsibleSidebar
  isCollapsed={leftPanelCollapsed}
  width={240}
  side="left"
>
  <DocumentTreeContainer />
</CollapsibleSidebar>
```

## Example Integration

Used in `DocumentPanel.tsx` wrapping `DocumentTreeContainer`:

```typescript
const effectiveLeftCollapsed = useUIStore(s =>
  selectEffectiveLeftCollapsed(s)
)

<CollapsibleSidebar
  isCollapsed={effectiveLeftCollapsed}
  width={200}
  side="left"
>
  {/* Tree content */}
</CollapsibleSidebar>
```

## Code Reference

`frontend/src/shared/components/layout/CollapsibleSidebar.tsx`

## Design Notes

**Presentational only** - No business logic, only rendering
**Collapse state** - Parent controls state, this component just renders
**Reusable** - Can wrap any sidebar content (tree, skill list, etc.)
