---
detail: comprehensive
audience: developer
---

# Stage 4: Disk Watch + One-Way Import (Disk -> App)

Goal: When the browser is open, changes on disk can flow back into Meridian.

## Watch Strategy

- Prefer native filesystem watcher in the bridge (per OS).
- Debounce/coalesce rapid events.
- Emit SSE events to the UI; UI decides when to fetch full content.

## Events (SSE)

- `fs.changed`:
  - `{ projectId, meridianPath, contentHash, mtime }`
- Optional: `fs.deleted`, `fs.renamed` (can defer to later stages if costly).

## API (Bridge)

- `GET /v1/fs/read?projectId=...&meridianPath=...`
  - output: `{ content, contentHash, mtime }`

## Frontend Handling (MVP)

On `fs.changed`:
- If the document is not currently dirty in the editor:
  - Fetch content from bridge
  - Persist to backend via `PATCH /api/documents/:id`
- If the document is dirty:
  - Mark conflict (no overwrite)

If file does not exist in Meridian:
- Create folder/doc via backend APIs (or reuse import endpoint if it fits).

## Stage Exit Criteria

- Editing a file on disk updates the corresponding Meridian document when no local edits exist.
- No silent overwrites when local edits exist.

