---
detail: standard
audience: developer
---

# API Contracts & Validation Rules

## Overview

Documents API contracts, validation rules, and frontend-backend expectations for Meridian's document management system.

## Folder Operations

### Update Folder (PUT /api/folders/:id)

- Moving to root uses an empty string for the parent identifier (not null), to disambiguate from omitted fields.
- Renaming and moving can be performed independently or combined in a single request.

Rationale: distinguishing an explicit move to root from “no change” avoids ambiguity in request payloads.

**Validation:**
- At least one field (`name` or `parent_id`) must be provided
- Folder names cannot contain `/` (regex: `^[^/]+$`)
- Max length: See `config.MaxFolderNameLength`
- Cannot create circular references (validated server-side)

**Implementation:** Details omitted here; behavior is defined by the validation and response rules below.

## Document Operations

### Update Document (PUT /api/documents/:id)

- Same patterns as folders, but use `folder_id` for moves. Moving to root uses an empty string.
- Supports rename, move, and content updates—these can be combined.

**Validation:**
- Document names **can contain** `/` for artistic titles (e.g., "Hero/Villain")
- No slash restriction on document names
- Max length: See `config.MaxDocumentNameLength`

**Why allow slashes in documents:** Documents are content/leaf nodes with flexible naming. Folders are structural hierarchy elements used in paths.

## Validation Rules Summary

| Entity   | Slash Allowed? | Reason                                    |
|----------|----------------|-------------------------------------------|
| Folders  | ❌ No          | Used in paths, structural elements        |
| Documents| ✅ Yes         | Artistic freedom, content not structure   |

Implementation notes: folder validation enforces the slash restriction; document validation does not restrict slashes.

## Error Responses

**Frontend handling:**
- Validation errors (400): display specific server message
- Server errors (500): generic error messaging with retry
- Conflict errors (409): e.g., folder not empty or circular move prevented

## Optimistic UI Expectations

**Phase 1 (Single-User):**
- Frontend updates local state immediately
- Backend is persistence layer only
- No conflict resolution needed
- No real-time sync

**Backend responsibilities:**
- Validate requests and persist changes
- Return updated entities with computed fields (e.g., a display path)
- Return clear error messages on validation/conflict

**Frontend responsibilities:**
- Update UI optimistically and send requests asynchronously
- Content edits: do not rollback on error; keep local and retry
- Structural operations: rollback local change on validation/conflict errors (400/409) and surface the server message
- Show a retry action on failures when appropriate

**See also:** Frontend flows documentation (`_docs/technical/frontend/flows.md`).

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
