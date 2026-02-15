---
detail: standard
audience: developer, architect
---
# Collaboration Spec: Snapshot Strategy and Retention

**Status:** Draft
**Purpose:** Define safety constraints for Yjs snapshot persistence and data retention.

## Key Simplification (Yjs + Go-Only)

The OT plan required a complex compaction pipeline (3 Graphile Worker services, composed changesets, tiered segments, advisory locks). With Yjs CRDTs running in Go, this collapses to **simple periodic snapshots**:

| OT Plan | Current Plan |
|---|---|
| `CompactionService` (Graphile Worker) | Periodic snapshot on disconnect + N updates |
| `RetentionService` (Graphile Worker) | Simple TTL cleanup for idempotency rows |
| `ProposalCleanupService` (Graphile Worker) | **Removed** — proposals retained indefinitely as permanent audit records |
| Composed changesets + segment table | Not needed — Yjs state doesn't require segment-based compaction (future: simple `ReplaceState` for growth bounding) |
| Advisory locks + row locks | Not needed — no concurrent compaction |
| `op_floor_version` / `snapshot_version` tracking | Not needed — Yjs state vectors handle versioning; snapshots tracked by `created_at` in `collab_document_snapshots` |
| Node service cleanup jobs | Go goroutine-based periodic tasks |
| `documents.content` dual-write | Replaced by derived projection — `content` and `ai_content` are computed from Yjs state on every persist, not written independently |
| `collab_ws_tickets` cleanup | Removed — JWT auth, no ticket table |

## Runtime Config (Env Vars)

v1 ships with 2 essential configs:

| Variable | Default | Bounds / Validation | Purpose |
|---|---|---|---|
| `MERIDIAN_COLLAB_SNAPSHOT_INTERVAL_UPDATES` | `500` | `>= 100` | Write snapshot every N Yjs updates as safety net |
| `MERIDIAN_COLLAB_AUTO_SNAPSHOT_RETENTION_DAYS` | `90` | `>= 30` | Keep auto snapshots before deletion |

Startup must fail fast on invalid values.

Proposal retention: accepted and rejected proposals are retained indefinitely as permanent audit records. No retention config or cleanup task needed.

## Snapshot Strategy

### When to Snapshot

1. **2s debounce timer** — resets on each Yjs update, fires 2s after last activity. Primary persistence trigger for active editing.
2. **Every N updates** — safety net for long-lived sessions (configurable via `MERIDIAN_COLLAB_SNAPSHOT_INTERVAL_UPDATES`).
3. **On WebSocket disconnect** — always snapshot when last client disconnects from a document.
4. **On explicit request** — admin/debug endpoint for manual snapshot.

### What Gets Written

Snapshots are stored in the `collab_document_snapshots` table (see `storage-model.md`):

1. `Y.encodeStateAsUpdate(doc)` -> write to `collab_document_snapshots.yjs_state`.
2. Also update `documents.yjs_state` with the latest state (the live document column).
3. Derive and persist `documents.content` via `doc.GetText("content").ToString()`.
4. Derive and persist `documents.ai_content` by cloning doc + applying all `status='proposed'` proposal updates + `ToString()`.

All three columns (`yjs_state`, `content`, `ai_content`) are written in one `UPDATE` — no dual-write drift because both text columns are always derived FROM the binary.

### First Load

1. Read `documents.yjs_state` from Postgres.
2. Create `Y.Doc` and apply stored state via `Y.applyUpdate()` in Go using `y-crdt`.
3. Yjs sync protocol handles any updates since snapshot automatically when WS connects.

### Snapshot Types

Stored in `collab_document_snapshots` table:

- `auto` — periodic safety snapshots (every N updates, on disconnect). Subject to retention cleanup.
- `named` — writer-created restore points. Retained indefinitely (writer must manually delete).
- `pre_restore` — auto-created before applying a restore. Retained with auto snapshots.

## Retention and Cleanup (v1)

All cleanup runs as Go goroutine-based periodic tasks (no external worker framework).

### Proposal Retention

- `proposed` rows remain raw queue items (never delete while pending).
- `accepted` and `rejected` rows are retained indefinitely as permanent audit records. No cleanup task needed.

### Snapshot Cleanup

- `auto` snapshots: `DELETE WHERE snapshot_type = 'auto' AND created_at < now() - interval '{AUTO_SNAPSHOT_RETENTION_DAYS} days'`.
- `named` snapshots: never auto-deleted (writer-owned).
- `pre_restore` snapshots: same retention as auto snapshots.

### Idempotency Cleanup

- `collab_request_idempotency`: Delete rows where `expires_at < now()`.

### Cleanup Schedule

| Task | Schedule | Query |
|---|---|---|
| Auto snapshot cleanup | Every 24 hours | `DELETE FROM collab_document_snapshots WHERE snapshot_type IN ('auto', 'pre_restore') AND created_at < now() - interval '{N} days'` |
| Idempotency cleanup | Every hour | `DELETE FROM collab_request_idempotency WHERE expires_at < now()` |

## Services/Code Removed (vs Previous Drafts)

| Removed | Reason |
|---|---|
| `CompactionService` | Periodic snapshots replace composed changesets; future `ReplaceState` for growth bounding |
| `RetentionService` | Simple `DELETE` queries for idempotency + snapshot cleanup (Go goroutines, not Graphile Worker) |
| `ProposalCleanupService` | **Removed** — proposals retained indefinitely as permanent audit records; no cleanup needed |
| `collab_document_compacted_segments` table | No segment-based compaction |
| `collab_document_state` table | No version/floor tracking needed |
| Advisory lock logic | No concurrent compaction contention |
| `documents.content` independent writes | Replaced by derived projections — `content` and `ai_content` computed from Yjs state on persist |
| `collab_ws_tickets` cleanup | JWT auth, no ticket table |
| Node service `setInterval` cleanup | Go goroutine periodic tasks |
| `MERIDIAN_COLLAB_COMPACTION_THRESHOLD` config | No compaction pipeline |
| `MERIDIAN_COLLAB_REPLAY_TAIL_OPS` config | No replay tail — Yjs handles sync |

## Future: Yjs State Compaction

As documents accumulate updates over months, the Yjs binary state grows. Periodic compaction (`Y.encodeStateAsUpdate()` -> replace stored state) bounds growth. This is tracked as a future optimization in `_docs/future/ideas/performance/yjs-periodic-compaction.md`.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/phase/phase-2-history-and-undo.md`
