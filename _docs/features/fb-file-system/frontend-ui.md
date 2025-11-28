---
stack: frontend
status: complete
feature: "File System Frontend UI"
---

# File System Frontend UI

**Tree view, context menus, and document navigation.**

## Status: ✅ Complete (with gaps)

---

## Tree View

**File**: `frontend/src/features/documents/components/DocumentTreePanel.tsx`

**Features**:
- Hierarchical folder/document display
- Folder expand/collapse (icon changes: Folder/FolderOpen)
- Active document highlighting
- Backend integration: `GET /api/projects/{id}/tree`

---

## Context Menus

**File**: `frontend/src/shared/components/TreeItemWithContextMenu.tsx`

**Document menu**: Rename, Delete, Add as Reference (stubbed)
**Folder menu**: Create Document, Create Folder, Rename, Delete
**Root menu**: Create Document, Create Folder

**UI**: Radix UI ContextMenu component

---

## Document Operations

**Create**: Inline name editor in tree (root `+` menu, folder context menu, or zero-state “Create a document”) → POST `/api/documents`
  - Enter / checkmark = confirm, ESC / “X” = cancel
  - Early blur without changes does not create a file/folder (guards against focus races)
**Rename**: Inline editor in tree → PATCH `/api/documents/{id}`
**Delete**: Confirmation → DELETE `/api/documents/{id}` + remove from IndexedDB

---

## Known Gaps

🟡 **Search UI** - Input present (`DocumentTreePanel.tsx:58-78`) but no filtering logic
❌ **Import UI** - No frontend dialog (backend exists)
❌ **Drag-and-drop** - No DnD library integrated

---

## Related

- See `/_docs/features/f-state-management/` for tree state management
