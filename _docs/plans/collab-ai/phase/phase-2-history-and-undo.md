---
detail: minimal
audience: developer
---
# Phase 2: History + Session Undo

**Status:** In planning
**Priority:** High
**Purpose:** Give writers durable rollback/restore with snapshot history plus reliable in-session undo.

## In Scope

- In-session undo/redo via `Y.UndoManager`.
- Named snapshot restore points stored in `collab_document_snapshots` table.
- Touched-document tracking for review workflows.

## Out of Scope

- AI proposal generation/arbitration.
- Multi-user live presence (available from Phase 1 but not the focus here).

## Canonical Data Rules

- Live document authority is the Yjs document state (`Y.Doc`).
- Snapshots are stored in the `collab_document_snapshots` table (not on the documents row).
- `Y.UndoManager` provides built-in undo/redo scoped to user changes.
- `Y.UndoManager` history is session-local by default; reload starts a new undo history unless separately persisted.
- Accepted AI edits can be undone through `Y.UndoManager` if they were applied within the undo scope.

## Deliverables

- `Y.UndoManager` integration in `@meridian/cm6-collab` package.
- Named snapshot model using `collab_document_snapshots` table (`auto`, `named`, `pre_restore` types).
- Snapshot REST API (defined during Phase 2 implementation):
  - `POST /api/documents/{id}/snapshots` — create named snapshot
  - `GET /api/documents/{id}/snapshots` — list snapshots (paginated)
  - `POST /api/documents/{id}/snapshots/{snapshotId}/restore` — restore from snapshot (creates `pre_restore` snapshot first)
  - `DELETE /api/documents/{id}/snapshots/{snapshotId}` — delete named snapshot (auto snapshots are cleaned by TTL)
- Undo/redo wired through `@meridian/cm6-collab` package; host app only binds UI shortcuts/state projection.
- `turn_document_touches` read model for "what changed" review entrypoints (schema TBD during Phase 2 implementation — tracks `document_id`, `thread_id`, `turn_id`, `touched_at` for provenance-based review).

## Dependencies

- Phase 1 transport/Yjs sync must be in place.
- Snapshot strategy from `_docs/plans/collab-ai/spec/compaction-retention.md`.
- CM6 package boundary contract from `_docs/plans/collab-ai/spec/cm6-library-model.md`.

## Implements Specs

- `_docs/plans/collab-ai/spec/compaction-retention.md`
- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/spec/cm6-library-model.md`

## Exit Criteria

- Cmd+Z works reliably within an active editing session (including accepted AI edits in undo scope).
- After reload, rollback remains available through named snapshot restore.
- Restore is non-destructive (creates new state, does not delete history).
- Named snapshots can be created and restored via Go backend.
- Writers can see touched docs per turn without scanning raw data.
- Undo logic remains package-owned (`@meridian/cm6-collab`), with no app-specific business logic fork.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/compaction-retention.md`
- `_docs/plans/collab-ai/spec/cm6-library-model.md`
