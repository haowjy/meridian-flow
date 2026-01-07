---
stack: both
status: complete
feature: "File System"
---

# File System

**Project/folder/document management with hierarchical tree structure.**

## Status: â Complete

---

## Features

### Backend (â Complete)

#### CRUD Operations
- Projects: Create, Read, Update, Delete (soft-delete)
- Folders: Nested hierarchy, path resolution
- Documents: Multi-format storage with extension support
- **Unique names enforced**: No duplicate filenames in same folder (HTTP 409 on conflict)
- See [backend-api.md](backend-api.md)

#### Multi-Format Support
- **Extensions**: `.md`, `.markdown`, `.txt` (markdown family), `.excalidraw`, `.mermaid`
- **Metadata**: Format-specific stats in JSONB (e.g., `metadata.markdown.wordCount`)
- **Uniqueness**: `(project_id, folder_id, name, extension)` - allows same name with different extensions
- See [file-types.md](file-types.md) for complete reference

#### Full-Text Search
- PostgreSQL FTS with `websearch_to_tsquery`
- Multi-language support (17 languages)
- Field-weighted ranking (name: 2.0x, content: 1.0x)
- See [search.md](search.md)

#### Multi-Format Import
- Bulk import from zip archives or individual files
- Supported formats: .zip, .md, .txt, .html (with XSS sanitization)
- Two modes: Merge (upsert) or Replace (delete all first)
- Auto-creates folders from directory structure
- See [import/](./import/) for detailed architecture

### Frontend (â Complete)

#### Tree View
- Hierarchical folder/document display
- Expand/collapse folders
- Active document highlighting
- Context menus with right-click actions (create, rename, delete, import)
- See [frontend-ui.md](frontend-ui.md) and `_docs/features/f-context-menus/`

#### Document Management
- â Create documents via context menu or dialog
- â Rename documents via context menu
- â Delete documents via context menu (with confirmation)
- â Folder creation/deletion via context menu
- â Navigation and selection

#### Import UI
- â Import dialog with drag-and-drop support
- â Multi-format support (.zip, .md, .txt, .html)
- â File validation and error reporting
- â Progress tracking and result summary
- See [import/](./import/) for detailed architecture

#### Known Gaps
- ð¡ **Search UI non-functional** - Search input present but doesn't filter tree (backend working)
- â **Drag-and-drop reordering** - Can't reorganize files via DnD (future enhancement)

---

## Implementation

### Backend Files
- `backend/internal/handler/{project,folder,document}.go` - HTTP handlers
- `backend/internal/service/docsystem/` - Business logic
- `backend/internal/service/docsystem/converter/` - Format converters (HTML, text, markdown)
- `backend/internal/repository/postgres/docsystem/` - Data access

### Frontend Files
- `frontend/src/features/documents/components/DocumentTreePanel.tsx` - Tree view
- `frontend/src/features/documents/components/ImportDocumentDialog.tsx` - Import UI
- `frontend/src/features/documents/components/CreateDocumentDialog.tsx` - Creation
- `frontend/src/shared/components/TreeItemWithContextMenu.tsx` - Context menus
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
- `PATCH /api/folders/{id}` - Update (rename, move)
- `DELETE /api/folders/{id}` - Delete (must be empty)

**Documents**:
- `POST /api/documents` - Create
- `GET /api/documents/{id}` - Get
- `PATCH /api/documents/{id}` - Update (rename, move, content)
- `DELETE /api/documents/{id}` - Soft-delete
- `GET /api/documents/search` - Full-text search

**Tree**:
- `GET /api/projects/{id}/tree` - Get complete project tree

**Import**:
- `POST /api/import` - Merge import (upsert, multipart/form-data)
- `POST /api/import/replace` - Replace import (delete all first, multipart/form-data)

---

## Document URLs

Documents use path-based slugs for semantic navigation:

| Location | URL Example |
|----------|------------|
| Root | `/projects/my-novel/documents/readme` |
| Nested | `/projects/my-novel/documents/characters/heroes/aria` |

**Benefits:**
- Semantic URLs reveal document location
- Natural disambiguation (`docs/readme` vs `src/readme`)
- Self-documenting bookmarks

**Implementation:**
- Frontend: TanStack Router splat route (`$.tsx`) captures all path segments
- Resolution: WorkspaceLayout resolves slug → UUID via tree store
- Cascade: Folder rename/move regenerates descendant document slugs

---

## Known Gaps & Future Enhancements

### Current Gaps
1. ð¡ **Search UI non-functional** - Search input exists but doesn't filter tree (backend working)
2. â **Drag-and-drop reordering** - Can't reorganize files/folders via DnD

### Future Enhancements
3. â **Vector search** - Semantic search using embeddings (requires LLM integration)
4. â **Hybrid search** - Combined FTS + vector search with re-ranking
5. â **Real-time collaboration** - Multi-user editing with conflict resolution
6. â **Version history** - Document versioning and rollback

---

## Related

- **Import System:** [import/](./import/) - Multi-format import with XSS protection
- **Context Menus:** `_docs/features/f-context-menus/` - Right-click actions for tree items
- **Search Architecture:** `_docs/technical/backend/search-architecture.md` - FTS implementation
- **Frontend Architecture:** `_docs/technical/frontend/` - Tree view patterns
