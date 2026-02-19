---
detail: standard
audience: developer
---

# ProjectSelector Component

**Dropdown menu for switching projects in global header.**

## Purpose

Provides quick project switching from the global header. Shows current project and list of all available projects.

## State Sources

**Projects**: `useProjectStore` - `projects` array, `currentProjectId`
**Route params**: `projectSlug` from URL
**Navigation**: TanStack Router `useNavigate()`

## Conditional Rendering

Only shows when `projectSlug` route param exists (i.e., user is in a project context).

```typescript
if (!projectSlug) return null
```

## Navigation Behavior

**Click project**: Navigates to `/projects/{slug}`
**Same project**: No navigation (already there)

## Dropdown Content

**Project List**:
- Each project as clickable item
- Checkmark on active project
- Separator after project list

**Bottom Link**:
- "All Projects" -> navigates to `/projects` (index)

## UI Structure

```
┌─────────────────────┐
│ [Icon] Project Name │  ← Trigger button
└─────────────────────┘
        ↓
┌─────────────────────┐
│ ✓ Current Project   │
│   Other Project 1   │
│   Other Project 2   │
│ ───────────────────│
│ All Projects        │
└─────────────────────┘
```

## Code Reference

`frontend/src/shared/components/layout/ProjectSelector.tsx`

## Integration

Used in `GlobalHeader` component (center position):

```typescript
<GlobalHeader>
  {/* Logo */}
  <ProjectSelector />  {/* Center */}
  {/* Settings + User */}
</GlobalHeader>
```

## Related Components

- [GlobalHeader](./global-header.md) - Parent component
- `useProjectStore` - Source of project data
