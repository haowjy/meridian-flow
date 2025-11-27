---
stack: frontend
status: complete
feature: context-menus
detail: standard
audience: developer
---

# Context Menus

**Stack:** Frontend Only
**Status:** ✅ Complete

Right-click context menus for file tree with reusable component architecture.

## Overview

Context menus provide quick access to common document and folder operations via right-click (or long-press on mobile).

**Available on:**
- Documents: Rename, Delete
- Folders: Create Document, Create Folder, Rename, Delete, Import
- Root: Create Document, Create Folder, Import

## Component Architecture

### Core Component

**TreeItemWithContextMenu** - Reusable wrapper that adds context menu to any tree item.

**Location:** `frontend/src/shared/components/TreeItemWithContextMenu.tsx`

**Usage:**
```tsx
<TreeItemWithContextMenu
  trigger={<div>My Document</div>}
  menuItems={documentMenuItems}
/>
```

**Props:**
- `trigger`: React node (the tree item)
- `menuItems`: Array of menu item definitions

### Menu Builders

**Location:** `frontend/src/features/documents/utils/menuBuilders.ts`

Three builder functions generate context-specific menu items:

1. **createDocumentMenuItems(document, callbacks)** - For documents
2. **createFolderMenuItems(folder, callbacks)** - For folders
3. **createRootMenuItems(projectId, callbacks)** - For root level

**Pattern:**
```typescript
export function createDocumentMenuItems(
  document: Document,
  callbacks: {
    onRename: () => void;
    onDelete: () => void;
  }
): MenuItem[] {
  return [
    { icon: Pencil, label: 'Rename', onClick: callbacks.onRename },
    { icon: Trash2, label: 'Delete', onClick: callbacks.onDelete, danger: true }
  ];
}
```

## Features

| Action | Document | Folder | Root | Notes |
|--------|----------|--------|------|-------|
| Create Document | ❌ | ✅ | ✅ | Opens create document dialog |
| Create Folder | ❌ | ✅ | ✅ | Opens create folder dialog |
| Rename | ✅ | ✅ | ❌ | Inline edit or dialog |
| Delete | ✅ | ✅ | ❌ | Confirmation dialog |
| Import | ❌ | ✅ | ✅ | Opens import dialog |

## User Experience

### Interaction

**Mouse:**
- Right-click on tree item → Menu appears
- Click menu item → Action executes
- Click outside menu → Menu closes

**Keyboard:**
- Tab to tree item → Focus outline appears
- Right-click key (context menu key) → Menu opens
- Arrow keys → Navigate menu items
- Enter → Execute action
- Escape → Close menu

**Touch (mobile):**
- Long-press on tree item → Menu appears
- Tap menu item → Action executes
- Tap outside → Menu closes

### Visual Design

**Menu styling (shadcn/ui):**
- Subtle border and shadow
- Hover: Light background
- Danger items (Delete): Red text + red hover
- Icons: Leading icon for each item
- Dividers: Separate action groups

**Example menu (folder):**
```
┌─────────────────────────┐
│ 📄 Create Document      │
│ 📁 Create Folder        │
├─────────────────────────┤
│ ✏️  Rename              │
│ 🗑️  Delete              │ (red)
├─────────────────────────┤
│ 📥 Import               │
└─────────────────────────┘
```

## Implementation Details

### Radix UI Integration

Uses `@radix-ui/react-context-menu` primitives:

```tsx
<ContextMenu>
  <ContextMenuTrigger asChild>
    {trigger}
  </ContextMenuTrigger>

  <ContextMenuContent>
    {menuItems.map(item => (
      <ContextMenuItem key={item.label} onClick={item.onClick}>
        <item.icon className="mr-2 h-4 w-4" />
        <span>{item.label}</span>
      </ContextMenuItem>
    ))}
  </ContextMenuContent>
</ContextMenu>
```

### Action Handlers

**Document rename:**
```tsx
const handleRename = () => {
  // Option 1: Inline edit (future)
  // Option 2: Dialog with input field
  openRenameDialog(document.id, document.name);
};
```

**Document delete:**
```tsx
const handleDelete = () => {
  // Confirmation dialog
  if (confirm(`Delete "${document.name}"?`)) {
    useTreeStore.getState().deleteDocument(document.id);
  }
};
```

**Folder create document:**
```tsx
const handleCreateDocument = () => {
  openCreateDocumentDialog({
    projectId: folder.project_id,
    folderId: folder.id
  });
};
```

### State Integration

**Tree Store Methods:**
- `createDocument(projectId, folderId, name, content)`
- `createFolder(projectId, parentId, name)`
- `deleteDocument(documentId)`
- `deleteFolder(folderId)`
- `renameDocument(documentId, newName)`
- `renameFolder(folderId, newName)`

After mutation, tree store automatically reloads to reflect changes.

## Extensibility

### Adding a New Menu Item

**Step 1:** Add to menu builder:
```typescript
export function createDocumentMenuItems(
  document: Document,
  callbacks: {
    onRename: () => void;
    onDelete: () => void;
    onDuplicate: () => void;  // NEW
  }
): MenuItem[] {
  return [
    { icon: Pencil, label: 'Rename', onClick: callbacks.onRename },
    { icon: Copy, label: 'Duplicate', onClick: callbacks.onDuplicate },  // NEW
    { icon: Trash2, label: 'Delete', onClick: callbacks.onDelete, danger: true }
  ];
}
```

**Step 2:** Implement callback in tree component:
```tsx
const menuItems = createDocumentMenuItems(document, {
  onRename: handleRename,
  onDelete: handleDelete,
  onDuplicate: () => handleDuplicate(document),  // NEW
});
```

**Step 3:** Implement handler:
```tsx
const handleDuplicate = (document: Document) => {
  useTreeStore.getState().duplicateDocument(document.id);
};
```

### Custom Menu for New Tree Item Type

**Example:** Adding context menu for "Tags" tree items:

```tsx
// 1. Create menu builder
export function createTagMenuItems(tag: Tag, callbacks): MenuItem[] {
  return [
    { icon: Edit, label: 'Edit Tag', onClick: callbacks.onEdit },
    { icon: Trash, label: 'Delete Tag', onClick: callbacks.onDelete, danger: true }
  ];
}

// 2. Use in tree component
const menuItems = createTagMenuItems(tag, {
  onEdit: handleEditTag,
  onDelete: handleDeleteTag
});

// 3. Wrap with TreeItemWithContextMenu
<TreeItemWithContextMenu
  trigger={<TagTreeItem tag={tag} />}
  menuItems={menuItems}
/>
```

## Keyboard Shortcuts (Future)

Context menus could integrate with keyboard shortcuts:

| Action | Shortcut | Current |
|--------|----------|---------|
| Rename | F2 | ❌ Not implemented |
| Delete | Del | ❌ Not implemented |
| Create Document | Ctrl+N | ❌ Not implemented |
| Create Folder | Ctrl+Shift+N | ❌ Not implemented |

**Implementation:** Add keyboard event listeners to tree items, call same handlers as context menu.

## Accessibility

### ARIA Attributes

```tsx
<ContextMenuTrigger
  aria-label={`${document.name} context menu`}
  aria-haspopup="menu"
>
  {trigger}
</ContextMenuTrigger>
```

### Screen Reader Announcements

- "Context menu available" when focused
- "Menu opened" when menu appears
- "{action} selected" when item clicked
- "Menu closed" when menu dismisses

### Focus Management

- Opening menu moves focus to first menu item
- Arrow keys navigate between items
- Escape returns focus to trigger element
- Executing action closes menu and returns focus

## Status

✅ **Production Ready**
- Reusable component architecture
- All CRUD operations supported
- Keyboard accessible
- Touch-friendly (long-press)
- Polished visual design

## Links

- **Implementation Guide:** [implementation.md](./implementation.md)
- **Usage Patterns:** [usage-patterns.md](./usage-patterns.md)
- **shadcn/ui Context Menu:** https://ui.shadcn.com/docs/components/context-menu

## Key Files

### Frontend
- `frontend/src/shared/components/TreeItemWithContextMenu.tsx` - Reusable wrapper component
- `frontend/src/features/documents/utils/menuBuilders.ts` - Menu item builders
- `frontend/src/components/ui/context-menu.tsx` - shadcn/ui primitives
- `frontend/src/core/stores/useTreeStore.ts` - Tree mutation methods

## Dependencies

- `@radix-ui/react-context-menu` (v2.2.16) - Context menu primitives
- `lucide-react` - Icons (Pencil, Trash2, FilePlus, FolderPlus, etc.)
