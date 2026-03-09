---
stack: frontend
status: complete
feature: "Custom Components"
---

# Custom Components

**Custom UI components built on shadcn/ui.**

## Status: ✅ Complete + Polished

---

## Key Components

### UI Components (in shared/components/ui/)

**CompactBreadcrumb** - Breadcrumb navigation
**StatusBadge** - Save status indicator (Saved/Saving/Error)

### Shared Components (in shared/components/)

**TreeItemWithContextMenu** - Context menu wrapper for tree items
**EmptyState** - Empty state placeholder
**ErrorPanel** - Error display with retry button

### Layout Components (in shared/components/layout/)

**WorkspaceRail** - Desktop navigation rail with view switching
**TwoPanelLayout** - Desktop resizable panel layout (see [layout system](../../technical/frontend/architecture/layout-system.md))
**MobileLayout** - Mobile tab navigation layout
**MobileBottomBar** - Mobile bottom navigation bar

### Feature-Specific Components

**Documents Feature**:
- CollapsibleSkillsSection - Expandable skills section in tree
- SkillTreeItem - Tree item for skills
- DocumentTreeItem, FolderTreeItem - Tree navigation items
- SelectableTreeItem - Base tree item with selection

**Threads Feature**:
- ChatHeader - Thread chat header
- ThreadSelector - Thread switcher dropdown

**Skills Feature**:
- SkillEditorPanel - Skill editing interface

### Core Infrastructure

**HeaderGradientFade** (core/components/) - Gradient fade below sticky headers (variants: `background`, `sidebar`)

**Location**: Distributed across `frontend/src/shared/components/`, `frontend/src/features/*/components/`, and `frontend/src/core/components/`

---

## Polish Level

✅ High polish:
- Consistent hover states
- Smooth transitions
- Responsive design
- Accessibility attributes (aria-label, aria-current)

---

## Related

- See [design-system.md](design-system.md) for base components
- See [loading-error-states.md](loading-error-states.md) for states
