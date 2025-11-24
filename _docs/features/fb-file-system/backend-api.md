---
stack: backend
status: complete
feature: "File System Backend API"
---

# File System Backend API

**CRUD operations, validation, and path resolution.**

## Status: ✅ Complete

---

## Features

**Projects** - Top-level containers
- Soft delete (recoverable)
- System prompt configuration per project
- Files: `backend/internal/{handler,service,repository}/*/project.go`

**Folders** - Hierarchical organization
- Nested structure via `parent_folder_id`
- Path computation (`/folder1/folder2/folder3`)
- Name validation (no `/` allowed)
- Files: `backend/internal/{handler,service,repository}/*/folder.go`

**Documents** - Markdown content
- Markdown storage (TEXT field)
- Word count tracking
- Folder placement
- Files: `backend/internal/{handler,service,repository}/*/document.go`

**Tree** - Efficient hierarchy retrieval
- Complete project structure in single request
- Files: `backend/internal/{handler,service}/*/tree.go`

---

## Validation Rules

**Names** (all entities):
- Automatically trimmed (leading/trailing whitespace)
- No `/` allowed (regex: `^[^/]+$`)
- Conflict detection: Unique (project_id, folder_id, name)

**Folders**:
- Must be empty to delete
- Path resolution via recursive queries

**Documents**:
- Optional folder placement (can be at project root)

---

## Database Features

- **Soft delete**: `deleted_at` timestamp
- **Timestamps**: Auto-update `updated_at`
- **RLS**: Row-level security enabled
- **Dynamic table names**: Environment-based prefix

---

## Related

- See `/_docs/technical/backend/api/contracts.md` for full API spec
