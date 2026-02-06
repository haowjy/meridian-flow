---
detail: comprehensive
audience: developer
---

# Stage 3: Filesystem Mount + One-Way Export (App -> Disk)

Goal: Export Meridian edits to real files without importing external changes yet (lowest risk).

## Data Model

- `Mount`:
  - `projectId`
  - `mountId`
  - `localPath` (absolute)
  - `mode`: `readonly` | `readwrite`
  - `createdAt`

## Path Mapping

- Disk-relative path is derived from Meridian `Document.path` (already includes folders + extension).
- Canonical Meridian path uses `/`; bridge maps to OS separators.
- No `..` segments allowed (reject).

## API (Bridge)

- `POST /v1/mounts`
  - input: `{ projectId, localPath, mode }`
  - output: `{ mountId, projectId, localPath, mode }`
- `GET /v1/mounts?projectId=...`
- `PUT /v1/fs/write`
  - input: `{ projectId, meridianPath, content, ifMatch?: lastSyncedHash }`
  - behavior: create folders as needed, write file atomically
  - output: `{ meridianPath, contentHash, mtime }`

## Frontend Integration

- After a successful server save, best-effort call `PUT /v1/fs/write`.
- Never block editor typing on bridge failures:
  - show a non-fatal "Local export failed" state per document/project.

## Stage Exit Criteria

- Editing in Meridian writes updated content to disk for the mounted project.
- Failures are visible but do not lose user edits.

