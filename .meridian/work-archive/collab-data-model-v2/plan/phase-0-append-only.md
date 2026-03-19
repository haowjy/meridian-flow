# Phase 0: Append-Only Persistence

## Scope and Intent

Migrate from merged-snapshot persistence (`documents.yjs_state` overwrite) to an append-only update log with checkpoints, bookmarks, and compaction. This is the foundation — all subsequent phases depend on it.

Also introduces `ai_turn` bookmark creation hook (used by Phase 5b restore).

## Files to Modify

| File | Change |
|------|--------|
| `backend/migrations/` (new) | Add `document_updates`, `document_checkpoints`, `document_bookmarks` tables |
| `backend/internal/service/collab/session_manager.go` | Replace `persistLocked()` overwrite with append. Replace `loadState()` with checkpoint+replay. Remove snapshot-on-N-updates logic. |
| `backend/internal/repository/postgres/collab/document_store.go` | Add `AppendUpdate()`, `LoadSinceCheckpoint()`, checkpoint CRUD. Keep old `LoadState`/`SaveState` temporarily for migration verification. |
| `backend/internal/domain/services/collab/collab.go` | Add `UpdateLogStore` and `BookmarkStore` interfaces. Keep `DocumentStateStore` temporarily. |
| New: `backend/internal/service/collab/compaction_worker.go` | Compaction worker: threshold check, advisory lock, bookmark materialization, merge, GC |
| New: `backend/internal/repository/postgres/collab/update_log_store.go` | `PostgresUpdateLogStore` implementing `UpdateLogStore` |
| New: `backend/internal/repository/postgres/collab/bookmark_store.go` | `PostgresBookmarkStore` implementing `BookmarkStore` |
| `backend/cmd/server/main.go` | Wire new stores, start compaction worker |

## Interface Contracts

### New interfaces (add to `collab.go`)

```go
type UpdateLogStore interface {
    AppendUpdate(ctx context.Context, docID string, update []byte, origin string, userID *string) (int64, error)
    LoadSinceCheckpoint(ctx context.Context, docID string) (checkpoint []byte, updates [][]byte, err error)
    CountUpdates(ctx context.Context, docID string) (int64, error)
    DeleteUpTo(ctx context.Context, docID string, cutoffID int64) error
}

type CheckpointStore interface {
    GetLatest(ctx context.Context, docID string) (state []byte, upToID int64, err error)
    Create(ctx context.Context, docID string, state []byte, upToID int64) error
}

type BookmarkStore interface {
    Create(ctx context.Context, bookmark *Bookmark) error  // with ON CONFLICT DO NOTHING
    ListByDocumentAndType(ctx context.Context, docID string, bookmarkType string) ([]Bookmark, error)
    ListByTurnID(ctx context.Context, turnID string) ([]Bookmark, error)
    GetState(ctx context.Context, bookmarkID string) ([]byte, error)
    MaterializeState(ctx context.Context, bookmarkID string, state []byte) error
    DeleteByTypeAndCutoff(ctx context.Context, docID string, bookmarkType string, cutoffUpdateID int64) error
}
```

### Bookmark model

```go
type Bookmark struct {
    ID           string
    DocumentID   string
    UpdateID     *int64   // NULL once materialized
    State        []byte   // materialized blob, NULL while pointer
    BookmarkType string   // "manual" | "daily" | "ai_turn" | "safety_restore"
    TurnID       *string
    Name         *string  // manual only
    CreatedBy    *string
    CreatedAt    time.Time
}
```

## Schema Migration

```sql
CREATE TABLE ${TABLE_PREFIX}document_updates (
    id          BIGSERIAL PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    update      BYTEA NOT NULL,
    origin      TEXT,
    user_id     UUID,
    created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_document_updates_doc_id ON ${TABLE_PREFIX}document_updates(document_id, id);

CREATE TABLE ${TABLE_PREFIX}document_checkpoints (
    id          BIGSERIAL PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    state       BYTEA NOT NULL,
    up_to_id    BIGINT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_document_checkpoints_doc ON ${TABLE_PREFIX}document_checkpoints(document_id, id DESC);

CREATE TABLE ${TABLE_PREFIX}document_bookmarks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    update_id       BIGINT,
    state           BYTEA,
    bookmark_type   TEXT NOT NULL,
    turn_id         UUID,
    name            TEXT,
    created_by      UUID,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (document_id, turn_id, bookmark_type)
);
CREATE INDEX idx_document_bookmarks_doc_type ON ${TABLE_PREFIX}document_bookmarks(document_id, bookmark_type);
```

## Pattern Reference

Follow existing `PostgresDocumentStore` patterns for the new store implementations:
- Same `repoConfig` constructor pattern
- Same `tablePrefix` handling
- Same error wrapping with `fmt.Errorf("operation: %w", err)`

## Key Implementation Notes

### SessionManager changes

**`persistLocked()`** — currently calls `stateStore.SaveState()` which overwrites `documents.yjs_state`. Change to:
- Extract the Yjs update delta (not full state) from the in-memory doc
- Call `updateLogStore.AppendUpdate(ctx, docID, updateDelta, origin, userID)`
- Remove snapshot-on-N-updates logic (replaced by compaction worker)

**`loadState()`** — currently calls `stateStore.LoadState()` which reads `documents.yjs_state`. Change to:
- `checkpointStore.GetLatest(ctx, docID)` → get latest checkpoint state + `upToID`
- `updateLogStore.LoadSinceCheckpoint(ctx, docID)` → get updates after checkpoint
- Apply checkpoint state + replay updates into fresh `ycrdt.Doc`
- Bootstrap path (no checkpoint, no updates) remains the same

**`ai_turn` bookmark creation** — Add a method `CreateAITurnBookmark(ctx, docID, turnID)` that:
- Gets the latest update ID from the log
- Creates a bookmark with `bookmark_type = "ai_turn"`, `update_id = latestUpdateID`, `turn_id = turnID`
- Called by the proposal creation flow before AI proposals are applied (wired in Phase 5b)

### Compaction worker

- Run as a goroutine started from `main.go`, triggered periodically (every 60s) or on demand
- For each document: `CountUpdates()` → if >= 20,000:
  1. `pg_advisory_xact_lock(document_id)` inside a transaction
  2. Fix `cutoff_update_id` as the 10,000th oldest row's ID
  3. Find manual/daily bookmarks with `update_id <= cutoff` → materialize state blobs by replaying log
  4. Delete ai_turn/safety_restore bookmarks with `update_id <= cutoff`
  5. Load updates `<= cutoff` + latest checkpoint → merge into new checkpoint
  6. Delete updates `<= cutoff`
  7. Commit transaction

### Migration path

1. Deploy new tables + new append path (both `SaveState` AND `AppendUpdate`)
2. Verify checkpoint+replay produces identical Y.Doc state to `yjs_state` overwrite
3. Switch `loadState()` to checkpoint+replay
4. Remove `SaveState` calls
5. Drop `documents.yjs_state` column (separate migration)
6. Migrate `collab_document_snapshots` to `document_bookmarks` (manual snapshots → `bookmark_type = "manual"`)
7. Drop `collab_document_snapshots` table

## Cleanup

| Artifact | Action |
|----------|--------|
| `documents.yjs_state` column | Remove after append-only is verified |
| `collab_document_snapshots` table | Migrate to `document_bookmarks`, then drop |
| `SnapshotStore` interface (snapshot parts) | Replace with `BookmarkStore` |
| `DeleteExpiredAutoSnapshots()` | Remove (replaced by compaction) |
| Snapshot-on-N-updates in `persistLocked()` | Remove |

## Verification Criteria

- [ ] `document_updates`, `document_checkpoints`, `document_bookmarks` tables exist with correct schema
- [ ] Document load via checkpoint + replay produces identical Y.Doc state to old `yjs_state` overwrite (golden test: save via old path, load via new path, compare)
- [ ] Compaction correctly merges oldest 10k updates into checkpoint at 20k threshold
- [ ] Compaction materializes manual/daily bookmarks within compaction range
- [ ] Compaction deletes ai_turn/safety_restore bookmarks within compaction range
- [ ] Compaction holds advisory lock for the entire transaction
- [ ] `documents.yjs_state` column is removed
- [ ] `collab_document_snapshots` table is dropped
- [ ] `CreateAITurnBookmark()` creates a bookmark pointing to the latest update ID
- [ ] Bookmark UNIQUE constraint `(document_id, turn_id, bookmark_type)` is present
- [ ] `go build ./...` passes
- [ ] Existing collab tests pass (may need adaptation for new persistence)
