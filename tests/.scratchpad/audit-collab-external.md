# Audit: Collab External Consistency (gpt-5.4, p24)

## REST vs WS Divergence

- **HIGH** `docsystem/document.go:203`, `docsystem/document.go:306`, `session_manager.go:328`, `llm/tools/text_editor.go:295` — `PATCH /api/documents/{id}` overwrites `content` and `ai_content` but never refreshes `yjs_state` or the live in-memory Y.Doc. A connected WS session keeps editing old state and can flush it back over the REST patch. Even rename/move resets the projected `ai_content`.

## Snapshot Restore Coordination

- **HIGH** `collab_snapshot.go:293`, `document_store.go:81`, `ai_content_projector.go:42`, `main.go:309` — `RestoreSnapshot` saves `ai_content` as `""` (blank AI reads), and because the handler is wired only to stores (not the session manager), an open WS session keeps using pre-restore in-memory state and can overwrite the restored document later.

## Stale/Empty Snapshots

- **MEDIUM** `collab_snapshot.go:116,280`, `session_manager.go:16,349` — `CreateSnapshot` only reads persisted `yjs_state`, so it can miss dirty in-memory edits. Pre-restore safety snapshot uses `LoadState` without the bootstrap fallback used by `CreateSnapshot`, so REST-only docs get empty backups.

## Auth Boundary Gap

- **MEDIUM** `collab_project.go:24,54`, `project.go:86` — Any authenticated user can open `/ws/projects/{projectId}` and receive `project:connected`. Authorization is deferred until `doc:subscribe`, unlike REST project endpoints which check project-level access.

## Error Response Inconsistency

- **MEDIUM** `document_resolver.go:47`, `collab_snapshot.go:371`, `collab_authenticator.go:116,130`, `helpers.go:41` — Snapshot REST turns missing/unauthorized/forbidden docs into the same `403 access denied`. WS `doc:subscribe` turns them into `FORBIDDEN` or `INTERNAL_ERROR`. Non-collab REST handlers preserve `404`/`401`/`403` distinctions.

## Deletion Lifecycle Gap

- **MEDIUM** `docsystem/project.go:181`, `docsystem/document.go:334`, `00018_collab_phase1_foundation.sql:19`, `00020_collab_proposals_and_idempotency.sql:8` — Soft deletes don't fire FK cascades for collab snapshots/proposals/idempotency rows. Idle WS subscriptions stay alive until next document traffic or disconnect.
