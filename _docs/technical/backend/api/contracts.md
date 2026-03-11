---
detail: minimal
audience: developer
---

# API Contracts

Route table with handler files. For auth pattern, see [authorization.md](../auth/authorization.md). For error format, see [error-responses.md](error-responses.md).

## Routes

| Method | Path | Purpose | Handler |
|--------|------|---------|---------|
| GET | `/health` | Health check (no auth) | `main.go` |
| **Projects** | | | `project.go` |
| GET | `/api/projects` | List user's projects | |
| POST | `/api/projects` | Create project | |
| GET | `/api/projects/{id}` | Get project (UUID or slug). Returns 404 for non-owner. | |
| PATCH | `/api/projects/{id}` | Update project (tri-state PATCH for nullable fields) | |
| DELETE | `/api/projects/{id}` | Soft-delete project | |
| POST | `/api/projects/{id}/favorite` | Add favorite | |
| DELETE | `/api/projects/{id}/favorite` | Remove favorite | |
| **Tree** | | | `tree.go` |
| GET | `/api/projects/{id}/tree` | Nested folder/document tree (metadata only) | |
| **Folders** | | | `folder.go` |
| POST | `/api/folders` | Create folder (supports path notation in `name`) | |
| GET | `/api/folders/{id}` | Get folder | |
| PATCH | `/api/folders/{id}` | Update/move folder | |
| DELETE | `/api/folders/{id}` | Recursive delete | |
| GET | `/api/folders/{id}/children` | List children | |
| **Documents** | | | `document.go` |
| POST | `/api/documents` | Create document (supports path notation in `name`) | |
| GET | `/api/documents/{id}` | Get document | |
| PATCH | `/api/documents/{id}` | Update/move document | |
| DELETE | `/api/documents/{id}` | Delete document | |
| GET | `/api/documents/search` | Full-text search (requires `project_id`, supports `limit`/`offset`) | |
| **Snapshots** | | | `snapshot.go` |
| POST | `/api/documents/{id}/snapshots` | Create snapshot | |
| GET | `/api/documents/{id}/snapshots` | List snapshots | |
| GET | `/api/documents/{id}/snapshots/{sid}/content` | Get snapshot content | |
| POST | `/api/documents/{id}/snapshots/{sid}/restore` | Restore snapshot | |
| DELETE | `/api/documents/{id}/snapshots/{sid}` | Delete snapshot | |
| **Import** | | | `import.go` |
| POST | `/api/import` | Merge import (zip) | |
| POST | `/api/import/replace` | Replace import (destructive) | |
| **Skills** | | | `skill.go` |
| GET | `/api/projects/{pid}/skills` | List skills | |
| POST | `/api/projects/{pid}/skills` | Create skill | |
| GET | `/api/projects/{pid}/skills/{sid}` | Get skill | |
| PUT | `/api/projects/{pid}/skills/{sid}` | Update skill | |
| DELETE | `/api/projects/{pid}/skills/{sid}` | Delete skill | |
| PUT | `/api/projects/{pid}/skills/reorder` | Reorder skills | |
| **Threads** | | | `thread.go` |
| GET | `/api/threads` | List threads (`?project_id=` required) | |
| POST | `/api/threads` | Create thread | |
| GET | `/api/threads/{id}` | Get thread | |
| PATCH | `/api/threads/{id}` | Update thread title | |
| DELETE | `/api/threads/{id}` | Soft-delete thread | |
| GET | `/api/threads/{id}/turns` | Paginated turns (`from_turn_id`, `limit`, `direction`) | |
| PATCH | `/api/threads/{id}/last-viewed-turn` | Update last viewed turn | |
| **Turns** | | | `turn.go` |
| POST | `/api/turns` | Create user turn + trigger assistant streaming | |
| GET | `/api/turns/{id}/path` | Ancestor chain for branch navigation | |
| GET | `/api/turns/{id}/siblings` | Sibling turns at branch point | |
| **Streaming** | | | `stream.go` |
| GET | `/api/turns/{id}/stream` | SSE streaming endpoint | |
| GET | `/api/turns/{id}/blocks` | Get completed blocks | |
| GET | `/api/turns/{id}/token-usage` | Token usage stats | |
| POST | `/api/turns/{id}/interrupt` | Cancel streaming turn | |
| **Interjections** | | | `interjection.go` |
| POST | `/api/turns/{id}/interjection` | Add/update interjection | |
| GET | `/api/turns/{id}/interjection` | Get interjection state | |
| DELETE | `/api/turns/{id}/interjection` | Clear interjection | |
| **Models** | | | `model.go` |
| GET | `/api/models/capabilities` | Available models grouped by provider | |
| **User Preferences** | | | `user_preferences.go` |
| GET | `/api/users/me/preferences` | Get preferences | |
| PATCH | `/api/users/me/preferences` | Update preferences (partial) | |
| **Collaboration** | | | |
| GET | `/ws/projects/{projectId}` | Project WebSocket -- JSON-only proposal commands/events (JWT in first message) | `collab.go` |
| GET | `/ws/documents/{documentId}` | Document WebSocket -- binary Yjs sync (`coder/websocket`, JWT in first message) | `collab_document_handler.go` |
| **Debug** | | | `debug.go` |
| POST | `/debug/api/threads/{id}/turns` | Debug create turn (dev only) | |
| GET | `/debug/api/threads/{id}/tree` | Debug thread tree (dev only) | |
| GET | `/debug/api/threads/{id}/turn-count` | Debug turn count (dev only) | |

All handlers in `backend/internal/handler/`. Route registration in `cmd/server/main.go`.
