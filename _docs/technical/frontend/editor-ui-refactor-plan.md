# Editor UI Refactor: Space-Efficient Layout

## Goal
Replace the current two-header design with a more compact, information-dense layout optimized for reading and AI workflows.

## New Layout Structure

```
┌─────────────────────────────────────────────────────────┐
│ ← | Chapters / ... / Chapter 1 - The Beginning      | ✕ │ ← Navigation Header
├─────────────────────────────────────────────────────────┤
│ B  I  H₁ H₂  • ≡                                       │ ← Toolbar
├─────────────────────────────────────────────────────────┤
│                                                         │
│                   TipTap Editor                         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ 1,234 words          ☁️ Saved 2 mins ago               │ ← Status Bar
└─────────────────────────────────────────────────────────┘
```

## Changes to Implement

### 1. Create New EditorHeader Component
- **Location**: `src/features/documents/components/EditorHeader.tsx`
- **Layout**: `Back button | Breadcrumbs | Close button`
  - Left: Back button (← icon) - closes document, returns to tree
  - Center: Breadcrumbs showing folder path with truncation (e.g., "Chapters / ... / Chapter 1 - The Beginning")
  - Right: Close button (✕ icon) - collapses entire right panel
- **Breadcrumbs logic**: Build path from folders array using document's folderId ancestry

### 2. Update EditorToolbar
- Keep existing formatting buttons
- Remove redundant padding/spacing
- Keep as-is structurally

### 3. Simplify EditorStatusBar
- **Remove**: Back button (moved to header), "Saved locally" text badge
- **Keep**: Word count on left
- **Replace status badge with icon**:
  - ☁️ Cloud icon = Saved successfully
  - ⟳ Spinner icon = Saving in progress
  - ⚠️ Warning icon = Save failed
- Show timestamp after icon ("2 mins ago")

### 4. Update EditorPanel
- Remove document name header (line 133-136)
- Replace with new EditorHeader component
- Wire up close button to collapse right panel via useUIStore

### 5. Add Breadcrumb Builder Utility
- **Location**: `src/core/lib/breadcrumbBuilder.ts`
- Function to build folder path from document's folderId
- Handle truncation with "..." when path is too long (e.g., > 3 folders)

## Files to Modify
1. **New**: `src/features/documents/components/EditorHeader.tsx`
2. **New**: `src/core/lib/breadcrumbBuilder.ts`
3. **Modify**: `src/features/documents/components/EditorPanel.tsx` (replace header)
4. **Modify**: `src/features/documents/components/EditorStatusBar.tsx` (remove back button, replace badge with icons)
5. **Create new**: `src/features/documents/components/SaveStatusIcon.tsx` (icon-based save status)

## Notes
- Breadcrumbs will show folder hierarchy only (no project name)
- Truncation uses "..." in the middle when path doesn't fit
- Save icon cycles through 3 states: saving (spinner) → saved (cloud) → error (warning)
- Close button collapses the entire right panel (both tree and editor)
