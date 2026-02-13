---
detail: minimal
audience: developer
---
# Phase 2: History + Persistent Undo

**Status:** In planning  
**Priority:** High  
**Purpose:** Give writers durable rollback/restore while preserving the op-log authority model.

## In Scope

- Persistent undo continuity across reload (replay-tail based in v1).
- Snapshot/compaction policy that keeps reconnect safe.
- Writer-facing restore/checkpoint semantics.
- Touched-document tracking for review workflows.

## Out of Scope

- AI proposal generation/arbitration.
- Multi-user live presence.

## Canonical Data Rules

- Live document authority remains the applied op stream.
- Snapshots are durability and fast-load aids, not a second authority stream.
- Any history/restore table must map cleanly back to authoritative versions.
- Accepted AI edits are authoritative ops (`origin='ai_accepted'`) and are compacted with the same policy as `origin='user'`.

## Deliverables

- Stable snapshot + floor-version invariants per document.
- Undo-tail retrieval contract for editor restore.
- Immutable history/checkpoint model for writer rollback.
- `turn_document_touches` read model for “what changed” review entrypoints.

## Dependencies

- Phase 1 transport/oplog must be in place.
- Refresh strategy from `_docs/plans/collab-ai/spec/refresh-read-model-framework.md`.
- Compaction/floor policy from `_docs/plans/collab-ai/spec/compaction-retention.md`.

## Implements Specs

- `_docs/plans/collab-ai/spec/compaction-retention.md`
- `_docs/plans/collab-ai/spec/refresh-read-model-framework.md`
- `_docs/plans/collab-ai/spec/storage-model.md`

## Exit Criteria

- Cmd+Z works after reload for recent edits (within replay tail).
- Restore is non-destructive (creates new head, does not delete history).
- Writers can see touched docs per turn without scanning raw blocks.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/refresh-read-model-framework.md`
- `_docs/plans/collab-ai/spec/compaction-retention.md`
