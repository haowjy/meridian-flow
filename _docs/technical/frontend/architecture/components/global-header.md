---
detail: standard
audience: developer
---

# GlobalHeader Component

**App-wide navigation bar across all authenticated pages.**

## Purpose

Provides consistent global navigation with project context, settings, and user menu. Fixed at top of all authenticated routes.

## Layout Structure

```
[Logo] ────────── [ProjectSelector] ────────── [Settings + User Menu]
 Left                   Center                        Right
```

## Specifications

**Height**: 36px (CSS variable `--global-header-height`)
**Position**: Fixed top
**Integration**: Used in `_authenticated.tsx` layout

## Props

None. Component reads from:
- Route params (`useParams()`)
- `useUserProfile()` hook
- `useAuthActions()` hook

## State Sources

- **User data**: `useUserProfile()` - avatar, display name
- **Auth actions**: `useAuthActions()` - sign out
- **Project context**: Route params `projectSlug`
- **Project list**: `useProjectStore()` (via ProjectSelector)

## Behavior

**Project Selector**: Only visible when `projectSlug` route param exists
**Settings**: Opens settings dialog
**User Menu**: Dropdown with sign out option

## Code Reference

`frontend/src/shared/components/layout/GlobalHeader.tsx`

## Related Components

- [ProjectSelector](./project-selector.md) - Project switcher dropdown
- `_authenticated.tsx` - Layout integration point
