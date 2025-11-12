---
detail: minimal
audience: developer
---

# API Overview

High-level overview of the Meridian REST API.

## Quick Reference

**Full contracts?** → [contracts.md](contracts.md)
**Error handling?** → [../api-contracts.md#error-responses](../api-contracts.md#error-responses)
**Testing?** → `backend/tests/insomnia-collection.json`

## Base URL

Development: `http://localhost:8080`
Production: TBD (Railway deployment)

## Authentication

**Phase 1:** Auth stub - uses hardcoded test IDs from environment

All requests automatically use:
- User ID: `TEST_USER_ID` (from `.env`)
- Project ID: `TEST_PROJECT_ID` (from `.env`)

**Future:** Real authentication with JWT tokens

## API Design Principles

### RESTful

- Resources: Projects, Folders, Documents
- Standard HTTP methods: GET, POST, PATCH, PUT, DELETE
- JSON request/response bodies
- HTTP status codes indicate success/failure

### Hierarchical Structure

```
Project (container)
├── Folder (optional, hierarchical)
│   ├── Subfolder
│   │   └── Document (content)
│   └── Document
└── Document (root-level)
```

### Path-Based Operations

**Option 1: Direct folder ID**
```json
{"folder_id": "uuid", "name": "Document"}
```

**Option 2: Auto-resolve path**
```json
{"folder_path": "Characters/Heroes", "name": "Aria"}
```

Server resolves path, creates folders as needed.

## Endpoint Categories

### Health Check

```
GET  /health
```

Returns server status. No auth required.

### Projects

```
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
```

Top-level containers for all user content.

**Deletion:** Requires all documents deleted first (prevents accidental data loss).

### Tree

```
GET /api/projects/:id/tree
```

Returns nested folder/document structure with metadata (no content).

**Use case:** Sidebar navigation, document browser.

### Folders

```
POST   /api/folders
GET    /api/folders/:id
PATCH  /api/folders/:id
DELETE /api/folders/:id
```

Hierarchical organization. Supports nesting, moving, renaming.

**Deletion:** Must be empty (no subfolders or documents).

**Circular prevention:** Cannot move folder into its own descendant.

### Documents

```
POST   /api/documents
GET    /api/documents/:id
PATCH  /api/documents/:id
DELETE /api/documents/:id
```

Content documents (markdown). Can be at root or in folders.

**Alias:** `POST /api/projects/:id/documents` (same as `/api/documents`)

### Import

```
POST /api/import          # Merge mode (upsert)
POST /api/import/replace  # Replace mode (delete all first)
```

Bulk import from zip files. Auto-creates folders based on directory paths.

**Format:** `multipart/form-data` with zip file(s)

## Common Patterns

### Root Level Convention

Root-level documents/folders use:
- `null` (JSON)
- `""` (empty string)
- Omit field entirely

All three are equivalent.

**Moving to root:**
```json
{"folder_id": ""}  // Empty string (not null) to disambiguate from "no change"
```

### Pagination

**Document System:** No pagination (returns all data)

**Chat System:** ✅ Implemented direction-based pagination for large conversations

- **Tree Endpoint:** ⚠️ `GET /debug/api/chats/:id/tree` (debug-only) - Lightweight structure for cache validation
- **Pagination Endpoint:** ✅ `GET /api/chats/:id/turns` (production) - Direction-based turn loading
  - Query params: `from_turn_id`, `limit` (max 200), `direction` (before/after/both)
  - Returns full Turn objects with nested blocks
  - Supports infinite scroll and context windows
  - Uses 25%/75% split for "both" direction (favors future context)

**Backend:** [Pagination Guide](../chat/pagination.md)
**Frontend:** `_docs/technical/frontend/chat-pagination-guide.md`

### Filtering

**Phase 1:** No filtering

**Future:** Query parameters for search, filtering

## Request/Response Format

### Standard Success Response

**Single resource:**
```json
{
  "id": "uuid",
  "name": "Resource Name",
  "created_at": "2025-11-06T10:00:00Z",
  "updated_at": "2025-11-06T10:00:00Z"
}
```

**Collection:**
```json
[
  {"id": "uuid-1", "name": "First"},
  {"id": "uuid-2", "name": "Second"}
]
```

### Standard Error Response

```json
{
  "error": "Human-readable error message"
}
```

### Conflict Response (409)

```json
{
  "error": "document 'Chapter 1' already exists",
  "conflict": {
    "type": "duplicate",
    "resource_type": "document",
    "resource_id": "uuid-of-existing",
    "location": "/api/documents/uuid-of-existing"
  }
}
```

## HTTP Status Codes

| Code | Meaning | When Used |
|------|---------|-----------|
| 200 | OK | Successful GET, PATCH, PUT |
| 201 | Created | Successful POST |
| 204 | No Content | Successful DELETE |
| 400 | Bad Request | Validation error, invalid JSON |
| 401 | Unauthorized | Missing/invalid auth (future) |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Duplicate resource, constraint violation |
| 500 | Internal Server Error | Server error (check logs) |

## Content Format

### Documents

**Stored format:** Markdown (TEXT)

**Request/Response:** Markdown string

```json
{
  "name": "Chapter 1",
  "content": "# Chapter 1\n\nOnce upon a time..."
}
```

**Frontend conversion:** TipTap ↔ Markdown happens at API boundary

### Computed Fields

**Path:**
- Not stored in database
- Computed from folder hierarchy
- Included in responses for display

**Word Count:**
- Computed from markdown content
- Updated on document create/update
- Stored in database for quick sorting

## Validation Rules

### Projects

- Name required, max 255 chars
- Trimmed of whitespace

### Folders

- Name required, max 255 chars
- **No slashes allowed** (used in paths)
- Regex: `^[^/]+$`

### Documents

- Name required, max 255 chars
- **No slashes allowed** (filesystem semantics)
- Regex: `^[^/]+$`
- Content can be empty string
- Import sanitizes `/` to `-`

## Rate Limiting

**Phase 1:** No rate limiting

**Future:** Add rate limits per user/IP

## Versioning

**Phase 1:** No versioning (API stable for MVP)

**Future:** Version in URL path (e.g., `/api/v2/...`) or header

## Testing

### Insomnia Collection

Pre-built API collection: `backend/tests/insomnia-collection.json`

**Import:**
1. Open Insomnia
2. Import → `backend/tests/insomnia-collection.json`
3. Set environment base URL
4. Start testing

### Manual curl

```bash
# Health check
curl http://localhost:8080/health

# List projects
curl http://localhost:8080/api/projects

# Get tree
curl http://localhost:8080/api/projects/{PROJECT_ID}/tree

# Create document
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "00000000-0000-0000-0000-000000000001",
    "name": "Test Document",
    "content": "# Test\n\nContent here"
  }'
```

## Next Steps

**Detailed contracts?** → [contracts.md](contracts.md)
**Error details?** → [contracts.md#error-responses](../api-contracts.md#error-responses)
**Setup API testing?** → [../development/testing.md](../development/testing.md)
