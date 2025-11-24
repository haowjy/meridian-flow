---
stack: both
status: complete
feature: "File System"
---

# File System

**Project/folder/document management with hierarchical tree structure.**

## Status:  Complete (with gaps)

---

## Features

### Backend ( Complete)

#### CRUD Operations
- Projects: Create, Read, Update, Delete (soft-delete)
- Folders: Nested hierarchy, path resolution
- Documents: Markdown storage, word count tracking
- See [backend-api.md](backend-api.md)

#### Full-Text Search
- PostgreSQL FTS with `websearch_to_tsquery`
- Multi-language support (17 languages)
- Field-weighted ranking (name: 2.0x, content: 1.0x)
- See [search.md](search.md)

#### ZIP Import
- Bulk import markdown files
- Two modes: Append (upsert) or Replace (delete all first)
- Auto-creates folders from directory structure
- See [import.md](import.md)

### Frontend (=á Mostly Complete)

#### Tree View
- Hierarchical folder/document display
- Expand/collapse folders
- Active document highlighting
- Context menus (right-click)
- See [frontend-ui.md](frontend-ui.md)

#### Document Management
- Create, rename, delete documents
- Folder creation/deletion
- Navigation and selection

#### Missing/Incomplete
- =á **Search UI** - Input exists but doesn't filter tree
- L **Import UI** - Backend exists, no frontend dialog
- L **Drag-and-drop** - No file reorganization

---

## Implementation

### Backend Files
- `backend/internal/handler/{project,folder,document}.go` - HTTP handlers
- `backend/internal/service/docsystem/` - Business logic
- `backend/internal/repository/postgres/docsystem/` - Data access

### Frontend Files
- `frontend/src/features/documents/components/DocumentTreePanel.tsx` - Tree view
- `frontend/src/features/documents/components/CreateDocumentDialog.tsx` - Creation
- `frontend/src/core/stores/useTreeStore.ts` - State management

---

## API Endpoints

**Projects**:
- `POST /api/projects` - Create
- `GET /api/projects` - List
- `GET /api/projects/{id}` - Get
- `PATCH /api/projects/{id}` - Update
- `DELETE /api/projects/{id}` - Soft-delete

**Folders**:
- `POST /api/folders` - Create
- `GET /api/folders/{id}` - Get
- `PATCH /api/folders/{id}` - Update
- `DELETE /api/folders/{id}` - Delete (must be empty)

**Documents**:
- `POST /api/documents` - Create
- `GET /api/documents/{id}` - Get
- `PATCH /api/documents/{id}` - Update
- `DELETE /api/documents/{id}` - Soft-delete
- `GET /api/documents/search` - Full-text search

**Tree**:
- `GET /api/projects/{id}/tree` - Get complete project tree

**Import**:
- `POST /api/import` - Merge import (upsert)
- `POST /api/import/replace` - Replace import (delete all first)

---

## Known Gaps

1. =á **Search UI non-functional** - Input present but doesn't filter
2. L **Import UI missing** - No frontend for ZIP uploads
3. L **Drag-and-drop** - Can't reorganize files via DnD
4. L **Vector search** - Only FTS, no semantic search
5. L **Hybrid search** - No combined FTS + vector

---

## Related

- See `/_docs/technical/backend/search-architecture.md` for search details
- See `/_docs/technical/frontend/` for frontend architecture
