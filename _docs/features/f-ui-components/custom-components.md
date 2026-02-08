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

**GlobalHeader** - App-wide navigation bar (see [technical docs](../../technical/frontend/architecture/components/global-header.md))
**ProjectSelector** - Project switcher dropdown (see [technical docs](../../technical/frontend/architecture/components/project-selector.md))
**CollapsibleSidebar** - Reusable sidebar wrapper (see [technical docs](../../technical/frontend/architecture/components/collapsible-sidebar.md))
**TwoPanelLayout** - Desktop resizable panel layout
**MobileTabLayout** - Mobile tab navigation layout

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
