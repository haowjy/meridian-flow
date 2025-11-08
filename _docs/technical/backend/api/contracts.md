---
detail: standard
audience: developer
---

# API Contracts & Validation Rules

## Project Operations

### List Projects (GET /api/projects)

- Returns all projects for the authenticated user
- Ordered by `updated_at DESC` (most recently updated first)
- Returns empty array `[]` if user has no projects

**Response:** Array of Project objects

### Create Project (POST /api/projects)

**Request Body:**
```json
{
  "name": "My New Project"
}
```

**Validation:**
- Name required (cannot be empty after trimming)
- Max length: 255 characters (see `config.MaxProjectNameLength`)
- Name is trimmed of leading/trailing whitespace

**Response:** Created Project object with generated `id`, `created_at`, and `updated_at`

### Get Project (GET /api/projects/:id)

- Returns single project by ID
- Returns 404 if project not found or doesn't belong to user

**Response:** Project object

### Update Project (PATCH /api/projects/:id)

**Request Body:**
```json
{
  "name": "Updated Project Name"
}
```

**Validation:**
- Same rules as Create Project
- Updates `updated_at` timestamp automatically

**Response:** Updated Project object

### Delete Project (DELETE /api/projects/:id)

- Deletes project if it has no documents
- Returns 409 Conflict if project contains documents (FK constraint with `ON DELETE RESTRICT`)
- Returns 404 if project not found
- Returns 204 No Content on success

**Safety:** User must delete all documents before deleting project (prevents accidental data loss)

### Get Project Tree (GET /api/projects/:id/tree)

- Returns the nested folder/document tree for a project
- Metadata only (no document content)

**Response:**
```json
{
  "folders": [
    {
      "id": "folder-uuid",
      "name": "Characters",
      "folder_id": null,
      "created_at": "2025-11-02T10:00:00Z",
      "folders": [
        {
          "id": "subfolder-uuid",
          "name": "Heroes",
          "folder_id": "folder-uuid",
          "created_at": "2025-11-02T10:05:00Z",
          "folders": [],
          "documents": []
        }
      ],
      "documents": [
        {
          "id": "doc-uuid",
          "name": "Aria Moonwhisper",
          "folder_id": "folder-uuid",
          "word_count": 312,
          "updated_at": "2025-11-02T12:03:45Z"
        }
      ]
    }
  ],
  "documents": [
    {
      "id": "root-doc-uuid",
      "name": "Quick Notes",
      "folder_id": null,
      "word_count": 57,
      "updated_at": "2025-11-02T11:47:12Z"
    }
  ]
}
```

Notes:
- This structure mirrors `TreeNode`/`FolderTreeNode`/`DocumentTreeNode` in the backend domain models.
- Designed for fast navigation; individual document content is fetched via `GET /api/documents/:id`.

## Folder Operations

### Create Folder (POST /api/folders)

**Request Body:**
```json
{
  "project_id": "uuid",
  "name": "Folder Name",
  "folder_id": ""  // Empty string for root level (or omit/null)
}
```

**Unix-style Path Notation (NEW):**

The `name` field now supports Unix-style path notation for creating nested folder hierarchies in a single request:

**Examples:**
```json
// Relative path - creates nested folders relative to folder_id
{
  "name": "Characters/Villains",
  "folder_id": null
}
// Creates: Characters (parent) → Villains (child)

// Absolute path - ignores folder_id, creates from root
{
  "name": "/Magic/Spells",
  "folder_id": "some-folder-id"
}
// Creates: Magic (root) → Spells (child), folder_id is ignored
```

**Path Notation Rules:**
- **Relative paths** (`a/b/c`): Creates folders relative to `folder_id` (or root if `folder_id` is null/omitted)
- **Absolute paths** (`/a/b/c`): Leading `/` means start from project root, ignoring `folder_id`
- **Auto-creation**: Intermediate folders are created automatically if they don't exist (idempotent)
- **Transaction**: All folders created atomically - if any fails, entire operation is rolled back
- **Final segment**: The last segment becomes the actual folder name

**Path Validation (Strict):**
- ❌ No consecutive slashes: `a//b` → 400 error
- ❌ No trailing slashes: `a/` → 400 error
- ❌ No empty segments
- ✅ Each segment must be valid folder name (alphanumeric, spaces, hyphens, underscores)
- ✅ Each segment length ≤ `config.MaxFolderNameLength`

**Root-level convention:**
- Use `""` (empty string), `null`, or omit `folder_id` for root-level folders
- All three are equivalent and create a folder at the project root

### Update Folder (PATCH /api/folders/:id)

- Moving to root uses an empty string for the parent identifier (not null), to disambiguate from omitted fields.
- Renaming and moving can be performed independently or combined in a single request.

Rationale: distinguishing an explicit move to root from "no change" avoids ambiguity in request payloads.

**Validation:**
- At least one field (`name` or `folder_id`) must be provided
- Simple folder names cannot contain `/` (regex: `^[^/]+$`)
- Path notation only supported in CREATE operations, not UPDATE
- Max length: See `config.MaxFolderNameLength`
- Cannot create circular references (validated server-side)

**Implementation:** Details omitted here; behavior is defined by the validation and response rules below.

## Import Operations

### Merge Import (POST /api/import)

Bulk import documents from zip file(s) in merge mode. Existing documents are updated, new ones are created.

**Request:**
- Method: POST
- Content-Type: multipart/form-data
- Field name: `files` (supports multiple zip files)
- Each zip file should contain markdown files with optional frontmatter

**Frontmatter Support:**
Documents can include YAML frontmatter with metadata:
```markdown
---
name: Document Name
folder: Characters/Heroes
---

Document content here...
```

**Behavior:**
- Creates folders automatically based on file paths or frontmatter
- Updates existing documents (same name + folder)
- Creates new documents if they don't exist
- Processes multiple zip files in single request

**Name Sanitization:**
- Document names containing `/` are automatically sanitized to `-` during import
- Prevents filesystem path confusion (document names follow same rules as folder names)
- Example: `"Hero/Villain"` in frontmatter becomes `"Hero-Villain"`
- Ensures imported documents meet validation rules

**Response:**
```json
{
  "success": true,
  "summary": {
    "created": 5,
    "updated": 2,
    "skipped": 0,
    "failed": 1,
    "total_files": 8
  },
  "errors": [
    {
      "file": "invalid.txt",
      "error": "file is not a zip file"
    }
  ],
  "documents": [
    {
      "id": "doc-uuid",
      "path": "Characters/Heroes/Aria",
      "name": "Aria",
      "action": "created"
    }
  ]
}
```

### Replace Import (POST /api/import/replace)

Bulk import documents from zip file(s) in replace mode. **Deletes all existing documents** in the project first, then imports.

**Request:** Same format as Merge Import

**Behavior:**
1. Deletes ALL documents in the project
2. Deletes ALL folders in the project
3. Imports all documents from zip file(s)
4. Creates folder structure from file paths

**Warning:** This is a destructive operation. All existing content will be permanently deleted before import.

**Response:** Same format as Merge Import

**Use Cases:**
- Merge Import: Sync changes, add new content
- Replace Import: Full project restore from backup, complete content refresh

## Document Operations

### Create Document (POST /api/documents)

**Request Body:**
```json
{
  "project_id": "uuid",
  "name": "Document Name",
  "content": "Markdown content",
  "folder_id": "",        // Empty string for root level (or omit/null)
  "folder_path": "Path"   // Alternative: use folder path instead
}
```

**Unix-style Path Notation in `name` Field (NEW):**

Similar to folders, the `name` field now supports Unix-style path notation for creating documents with auto-created folder hierarchies:

**Examples:**
```json
// Relative path - creates folders and document relative to folder_id
{
  "name": "Locations/Cities/Stormhaven",
  "folder_id": null,
  "content": "# Stormhaven\n\nA coastal city..."
}
// Creates: Locations → Cities → Document "Stormhaven"

// Absolute path - ignores folder_id, creates from root
{
  "name": "/Worldbuilding/timeline",
  "folder_id": "some-folder-id",
  "content": "# Timeline\n\nHistory..."
}
// Creates: Worldbuilding (root) → Document "timeline", folder_id is ignored
```

**Path Notation Rules:**
- **Relative paths** (`a/b/doc`): Creates folders relative to `folder_id` (or root if `folder_id` is null/omitted)
- **Absolute paths** (`/a/b/doc`): Leading `/` means start from project root, ignoring `folder_id`
- **Auto-creation**: Intermediate folders are created automatically (idempotent)
- **Transaction**: All folders and document created atomically
- **Final segment**: The last segment becomes the document name
- **Priority**: If `name` contains path notation, it overrides both `folder_id` and `folder_path`

**Path Validation (Strict):**
- Same strict rules as folder path notation
- ❌ No consecutive slashes, trailing slashes, or empty segments
- ✅ Each segment (except final) must be valid folder name
- ✅ Final segment must be valid document name

**Root-level convention:**
- Use `""` (empty string), `null`, or omit `folder_id`/`folder_path` for root-level documents
- All three are equivalent and create a document at the project root
- **Resolution priority** (when `name` has NO path notation):
  1. `folder_id` (direct folder reference) - frontend optimization
  2. `folder_path` (legacy path resolution) - external AI/import

### Update Document (PATCH /api/documents/:id)

- Same patterns as folders, but use `folder_id` for moves. Moving to root uses an empty string.
- Supports rename, move, and content updates—these can be combined.
- Content format is Markdown. Requests that update content provide a `content` field; responses include `content`.
- **Path notation NOT supported in UPDATE** - only in CREATE operations

**Validation:**
- Simple document names **cannot contain** `/` (filesystem semantics, regex: `^[^/]+$`)
- Path notation only supported in CREATE operations, not UPDATE
- Names are automatically trimmed of leading/trailing whitespace
- Max length: See `config.MaxDocumentNameLength`

**Rationale:** Documents follow filesystem naming conventions. Use folder structure for hierarchy, not slashes in document names.

**Content format:**
- Canonical content stored and emitted by the API is Markdown.
- The frontend editor uses a different internal representation and converts to/from Markdown at the boundary.
- Word count and similar derived fields are computed from Markdown.

## Validation Rules Summary

| Entity   | Slash Allowed? | Max Length | Reason                                    |
|----------|----------------|------------|-------------------------------------------|
| Projects | N/A            | 255        | Top-level container                       |
| Folders  | ✅ CREATE only (path notation) / ❌ UPDATE | 255 | Path notation for CREATE, simple names for UPDATE |
| Documents| ✅ CREATE only (path notation) / ❌ UPDATE | 255 | Path notation for CREATE, simple names for UPDATE |

**Implementation notes:**
- **CREATE operations**: `name` field supports Unix-style path notation (`a/b/c` or `/a/b/c`)
  - Path notation auto-creates intermediate folders
  - Final segment must be valid simple name (no slashes)
  - Strict validation: no `//`, no trailing `/`, no empty segments
- **UPDATE operations**: Simple names only (no slashes), regex: `^[^/]+$`
- **Import**: Automatically sanitizes slashes to hyphens in document names

## Error Responses

### Standard Error Format

Most errors return a simple JSON object:
```json
{
  "error": "Human-readable error message"
}
```

### Conflict Errors (409)

**For creation conflicts** (duplicate documents, folders, or projects), the response includes structured details about the existing resource:

```json
{
  "error": "document 'Chapter 1' already exists in this location",
  "conflict": {
    "type": "duplicate",
    "resource_type": "document",
    "resource_id": "uuid-of-existing-document",
    "location": "/api/documents/uuid-of-existing-document"
  }
}
```

**For other conflicts** (e.g., folder not empty, project has documents), returns simple error format:
```json
{
  "error": "folder contains 3 documents"
}
```

**Frontend handling:**
- Validation errors (400): display specific server message
- Server errors (500): generic error messaging with retry
- Conflict errors (409): can fetch existing resource via `conflict.resource_id` or `conflict.location` if provided

## Frontend Expectations

**Phase 1 (Single-User):**
- Frontend updates optimistically; backend validates and persists
- Content edits: don't rollback on error (keep local, retry)
- Structural ops: rollback on 400/409 and show server message

**See:** Frontend state management documentation

## Path Computation

Both folders and documents include a computed `path` field in responses.

Paths are computed server‑side (not stored), and returned with entities for display purposes.

## Special Cases

### Empty Folder Deletion

Folders must be empty before deletion (no subfolders or documents).

On attempted deletion, if the folder contains subfolders or documents the server returns a conflict error.

### Circular Reference Prevention

Backend prevents moving folder to be a child of its own descendant.

**Example:** Cannot move "World Building" into "World Building/Characters"

Moves that would create circular references are rejected with a validation error.

## References

See the frontend state management and flows documentation for complementary guidance.
