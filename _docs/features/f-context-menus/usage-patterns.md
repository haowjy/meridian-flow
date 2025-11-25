---
stack: frontend
status: complete
feature: context-menus
detail: standard
audience: developer
---

# Context Menu Usage Patterns

Practical patterns and recipes for common context menu scenarios.

## Pattern 1: Basic Tree Item Menu

**Use case:** Simple context menu with 2-3 actions.

```tsx
function SimpleDocumentItem({ document }: { document: Document }) {
  const { deleteDocument } = useTreeStore();

  const menuItems = [
    {
      icon: Pencil,
      label: 'Rename',
      onClick: () => console.log('Rename', document.name),
    },
    {
      icon: Trash2,
      label: 'Delete',
      onClick: () => deleteDocument(document.id),
      danger: true,
    },
  ];

  return (
    <TreeItemWithContextMenu
      trigger={<div>{document.name}</div>}
      menuItems={menuItems}
    />
  );
}
```

**When to use:**
- Simple tree items with few actions
- No need for builders (inline is clearer)
- Prototyping or one-off components

## Pattern 2: Menu with Dialog Integration

**Use case:** Actions that require user input (rename, create).

```tsx
function DocumentWithDialogs({ document }: { document: Document }) {
  const [isRenaming, setIsRenaming] = useState(false);
  const { deleteDocument, renameDocument } = useTreeStore();

  const menuItems = createDocumentMenuItems(document, {
    onRename: () => setIsRenaming(true),
    onDelete: () => {
      if (confirm(`Delete "${document.name}"?`)) {
        deleteDocument(document.id);
      }
    },
  });

  return (
    <>
      <TreeItemWithContextMenu
        trigger={<div>{document.name}</div>}
        menuItems={menuItems}
      />

      <RenameDialog
        open={isRenaming}
        onOpenChange={setIsRenaming}
        initialName={document.name}
        onRename={(name) => renameDocument(document.id, name)}
      />
    </>
  );
}
```

**When to use:**
- Actions need user input beyond confirm()
- Multiple steps required (e.g., create with options)
- Want polished UX with validation

## Pattern 3: Conditional Menu Items

**Use case:** Enable/disable actions based on state.

```tsx
function FolderWithConditionalMenu({ folder }: { folder: Folder }) {
  const isEmpty = folder.documents.length === 0 && folder.subfolders.length === 0;
  const { deleteFolder } = useTreeStore();

  const menuItems = [
    {
      icon: FilePlus,
      label: 'Create Document',
      onClick: handleCreateDocument,
    },
    {
      icon: Trash2,
      label: isEmpty ? 'Delete' : 'Delete (folder not empty)',
      onClick: () => deleteFolder(folder.id),
      disabled: !isEmpty,
      danger: true,
    },
  ];

  return (
    <TreeItemWithContextMenu
      trigger={<div>{folder.name}</div>}
      menuItems={menuItems}
    />
  );
}
```

**When to use:**
- Actions only valid in certain states
- Show disabled items with explanation
- Prevent invalid operations

## Pattern 4: Dynamic Menu Items

**Use case:** Menu content changes based on context.

```tsx
function DocumentWithDynamicMenu({ document }: { document: Document }) {
  const { favoriteDocuments } = useUserStore();
  const isFavorited = favoriteDocuments.includes(document.id);

  const menuItems = [
    {
      icon: isFavorited ? StarOff : Star,
      label: isFavorited ? 'Remove from Favorites' : 'Add to Favorites',
      onClick: () => toggleFavorite(document.id),
    },
    {
      icon: Pencil,
      label: 'Rename',
      onClick: handleRename,
    },
    {
      icon: Trash2,
      label: 'Delete',
      onClick: handleDelete,
      danger: true,
    },
  ];

  return (
    <TreeItemWithContextMenu
      trigger={<div>{document.name}</div>}
      menuItems={menuItems}
    />
  );
}
```

**When to use:**
- Toggle actions (favorite, pin, lock)
- Context-dependent labels or icons
- User preferences affect menu

## Pattern 5: Grouped Menu Items with Separators

**Use case:** Organize many actions into logical groups.

```tsx
function DocumentWithGroupedMenu({ document }: { document: Document }) {
  const menuItems: MenuItem[] = [
    // Edit group
    { icon: Pencil, label: 'Rename', onClick: handleRename },
    { icon: Copy, label: 'Duplicate', onClick: handleDuplicate },
    { type: 'separator' },

    // Move group
    { icon: FolderOpen, label: 'Move to Folder', onClick: handleMove },
    { icon: ArrowUp, label: 'Move Up', onClick: handleMoveUp },
    { type: 'separator' },

    // Danger group
    { icon: Trash2, label: 'Delete', onClick: handleDelete, danger: true },
  ];

  return (
    <TreeItemWithContextMenu
      trigger={<div>{document.name}</div>}
      menuItems={menuItems}
    />
  );
}
```

**When to use:**
- More than 5 menu items
- Logically distinct action groups
- Separate destructive actions visually

## Pattern 6: Sub-Menu (Nested Menu)

**Use case:** Secondary actions under a parent menu item.

```tsx
function DocumentWithSubMenu({ document }: { document: Document }) {
  const folders = useFolders();

  const menuItems: MenuItem[] = [
    { icon: Pencil, label: 'Rename', onClick: handleRename },
    {
      icon: FolderOpen,
      label: 'Move to',
      subItems: folders.map(folder => ({
        icon: Folder,
        label: folder.name,
        onClick: () => moveToFolder(document.id, folder.id),
      })),
    },
    { type: 'separator' },
    { icon: Trash2, label: 'Delete', onClick: handleDelete, danger: true },
  ];

  return (
    <TreeItemWithContextMenu
      trigger={<div>{document.name}</div>}
      menuItems={menuItems}
    />
  );
}
```

**When to use:**
- Many related options (e.g., move to any folder)
- Hierarchical actions
- Keep top-level menu concise

## Pattern 7: Permission-Based Menu

**Use case:** Different users see different actions.

```tsx
function DocumentWithPermissions({ document }: { document: Document }) {
  const { user, isOwner, canEdit, canDelete } = usePermissions(document);

  const menuItems = [
    canEdit && {
      icon: Pencil,
      label: 'Rename',
      onClick: handleRename,
    },
    canEdit && {
      icon: Copy,
      label: 'Duplicate',
      onClick: handleDuplicate,
    },
    { type: 'separator' },
    canDelete && {
      icon: Trash2,
      label: 'Delete',
      onClick: handleDelete,
      danger: true,
    },
  ].filter(Boolean) as MenuItem[];

  return (
    <TreeItemWithContextMenu
      trigger={<div>{document.name}</div>}
      menuItems={menuItems}
    />
  );
}
```

**When to use:**
- Multi-user applications
- Role-based access control
- Hide unavailable actions (don't just disable)

## Pattern 8: Keyboard Shortcut Integration

**Use case:** Show keyboard shortcuts in menu, trigger same action.

```tsx
function DocumentWithShortcuts({ document }: { document: Document }) {
  const handleRename = () => {
    // Rename logic
  };

  const handleDelete = () => {
    // Delete logic
  };

  // Keyboard listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        handleRename();
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        handleDelete();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const menuItems = [
    {
      icon: Pencil,
      label: 'Rename',
      onClick: handleRename,
      shortcut: 'F2',
    },
    {
      icon: Trash2,
      label: 'Delete',
      onClick: handleDelete,
      shortcut: 'Del',
      danger: true,
    },
  ];

  return (
    <TreeItemWithContextMenu
      trigger={<div>{document.name}</div>}
      menuItems={menuItems}
    />
  );
}
```

**When to use:**
- Power users expect keyboard shortcuts
- Common actions (rename, delete, duplicate)
- Visual hint for discoverability

## Pattern 9: Loading States in Menu Actions

**Use case:** Async actions with loading feedback.

```tsx
function DocumentWithAsyncActions({ document }: { document: Document }) {
  const [isDeleting, setIsDeleting] = useState(false);
  const { deleteDocument } = useTreeStore();

  const handleDelete = async () => {
    if (!confirm(`Delete "${document.name}"?`)) return;

    setIsDeleting(true);
    try {
      await deleteDocument(document.id);
      toast.success('Document deleted');
    } catch (error) {
      toast.error('Failed to delete document');
    } finally {
      setIsDeleting(false);
    }
  };

  const menuItems = [
    { icon: Pencil, label: 'Rename', onClick: handleRename },
    {
      icon: isDeleting ? Loader : Trash2,
      label: isDeleting ? 'Deleting...' : 'Delete',
      onClick: handleDelete,
      disabled: isDeleting,
      danger: true,
    },
  ];

  return (
    <TreeItemWithContextMenu
      trigger={<div>{document.name}</div>}
      menuItems={menuItems}
    />
  );
}
```

**When to use:**
- Network requests from menu actions
- Prevent double-clicks during processing
- Show feedback for slow operations

## Pattern 10: Multi-Select Context Menu

**Use case:** Bulk actions on multiple selected items.

```tsx
function TreeWithMultiSelect() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { deleteDocuments } = useTreeStore();

  const handleDeleteSelected = () => {
    if (confirm(`Delete ${selectedIds.length} documents?`)) {
      deleteDocuments(selectedIds);
      setSelectedIds([]);
    }
  };

  const bulkMenuItems = [
    {
      icon: Trash2,
      label: `Delete ${selectedIds.length} documents`,
      onClick: handleDeleteSelected,
      danger: true,
    },
    {
      icon: FolderOpen,
      label: 'Move to Folder',
      onClick: handleMoveSelected,
    },
  ];

  return (
    <div>
      {selectedIds.length > 0 && (
        <TreeItemWithContextMenu
          trigger={<div>Selected: {selectedIds.length}</div>}
          menuItems={bulkMenuItems}
        />
      )}

      {/* Tree items with selection checkboxes */}
    </div>
  );
}
```

**When to use:**
- Bulk operations on tree items
- Power user workflows
- Reduce repetitive actions

## Anti-Patterns (Avoid These)

### ❌ Too Many Menu Items

```tsx
// Bad: 15 menu items, overwhelming
const menuItems = [
  { label: 'Rename' },
  { label: 'Duplicate' },
  { label: 'Copy' },
  { label: 'Cut' },
  { label: 'Paste' },
  { label: 'Move to' },
  { label: 'Copy to' },
  { label: 'Favorite' },
  { label: 'Pin' },
  { label: 'Share' },
  { label: 'Export' },
  { label: 'Properties' },
  { label: 'Permissions' },
  { label: 'History' },
  { label: 'Delete' },
];
```

**Fix:** Use sub-menus or group into categories.

### ❌ Unclear Action Labels

```tsx
// Bad: Vague or technical labels
const menuItems = [
  { label: 'Edit' },  // Edit what? Name? Content?
  { label: 'Remove' },  // Remove from list or delete?
  { label: 'Execute' },  // Too generic
];

// Good: Clear, specific labels
const menuItems = [
  { label: 'Rename' },
  { label: 'Delete Permanently' },
  { label: 'Run Script' },
];
```

### ❌ Missing Danger Styling

```tsx
// Bad: Delete action looks the same as others
{ icon: Trash2, label: 'Delete', onClick: handleDelete }

// Good: Danger styling warns user
{ icon: Trash2, label: 'Delete', onClick: handleDelete, danger: true }
```

### ❌ No Confirmation for Destructive Actions

```tsx
// Bad: Delete immediately without confirmation
const handleDelete = () => {
  deleteDocument(document.id);  // Dangerous!
};

// Good: Confirm before deleting
const handleDelete = () => {
  if (confirm(`Delete "${document.name}"?`)) {
    deleteDocument(document.id);
  }
};
```

### ❌ Disabled Items Without Explanation

```tsx
// Bad: Disabled with no reason
{ label: 'Delete', disabled: true }

// Good: Explain why disabled
{ label: 'Delete (folder not empty)', disabled: true }

// Even better: Hide unavailable actions
menuItems.filter(item => item.available)
```

## Testing Strategies

### Test Menu Item Generation

```typescript
describe('Menu Builders', () => {
  it('should generate correct items for empty folder', () => {
    const folder = { id: '1', name: 'Empty', children: [] };
    const items = createFolderMenuItems(folder, callbacks, { isEmpty: true });

    const deleteItem = items.find(i => i.label === 'Delete');
    expect(deleteItem?.disabled).toBe(false);
  });

  it('should disable delete for non-empty folder', () => {
    const folder = { id: '1', name: 'Full', children: [{ id: '2' }] };
    const items = createFolderMenuItems(folder, callbacks, { isEmpty: false });

    const deleteItem = items.find(i => i.label === 'Delete');
    expect(deleteItem?.disabled).toBe(true);
  });
});
```

### Test User Interactions

```typescript
describe('Context Menu Interactions', () => {
  it('should open menu on right-click', () => {
    render(<DocumentTreeItem document={doc} />);

    const item = screen.getByText(doc.name);
    fireEvent.contextMenu(item);

    expect(screen.getByText('Rename')).toBeVisible();
  });

  it('should close menu after action', async () => {
    render(<DocumentTreeItem document={doc} />);

    fireEvent.contextMenu(screen.getByText(doc.name));
    fireEvent.click(screen.getByText('Rename'));

    await waitFor(() => {
      expect(screen.queryByText('Rename')).not.toBeInTheDocument();
    });
  });
});
```

### Test Keyboard Navigation

```typescript
it('should navigate menu with arrow keys', () => {
  render(<DocumentTreeItem document={doc} />);

  fireEvent.contextMenu(screen.getByText(doc.name));

  const firstItem = screen.getByText('Rename');
  expect(firstItem).toHaveFocus();

  fireEvent.keyDown(firstItem, { key: 'ArrowDown' });

  const secondItem = screen.getByText('Delete');
  expect(secondItem).toHaveFocus();
});
```

## Performance Considerations

### Memoize Menu Items

```tsx
const menuItems = useMemo(
  () => createDocumentMenuItems(document, {
    onRename: handleRename,
    onDelete: handleDelete,
  }),
  [document.id, handleRename, handleDelete]
);
```

**Why:** Prevents recreating menu items array on every render.

### Lazy Load Sub-Menus

```tsx
// Don't fetch all folders upfront
const [folders, setFolders] = useState<Folder[]>([]);

const handleSubMenuOpen = async () => {
  if (folders.length === 0) {
    const fetchedFolders = await api.folders.list();
    setFolders(fetchedFolders);
  }
};

<ContextMenuSub onOpenChange={(open) => open && handleSubMenuOpen()}>
  {/* Sub-menu content */}
</ContextMenuSub>
```

**Why:** Only load data when user interacts with sub-menu.

## Accessibility Checklist

- [ ] Menu items have clear, descriptive labels
- [ ] Destructive actions use danger styling (red text)
- [ ] Keyboard navigation works (arrows, Enter, Escape)
- [ ] Screen reader announces menu state changes
- [ ] Focus returns to trigger after menu closes
- [ ] Disabled items explain why they're disabled
- [ ] Keyboard shortcuts match menu actions

## Key Files

- `frontend/src/shared/components/TreeItemWithContextMenu.tsx` - Core component
- `frontend/src/features/documents/utils/menuBuilders.ts` - Menu builders
- `frontend/src/core/stores/useTreeStore.ts` - Tree actions

## References

- **Radix UI Context Menu:** https://www.radix-ui.com/primitives/docs/components/context-menu
- **ARIA Context Menu:** https://www.w3.org/WAI/ARIA/apg/patterns/menubutton/
- **shadcn/ui Context Menu:** https://ui.shadcn.com/docs/components/context-menu
