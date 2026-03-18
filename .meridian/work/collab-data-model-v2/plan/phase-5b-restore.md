# Phase 5b: Turn-Level Restore

## Scope and Intent

Implement turn-level restore: revert all documents edited in an AI turn to their pre-turn state using `ai_turn` bookmarks. This is backend-coordinated (not local-first) and includes both backend logic (session freeze, state replacement, safety bookmarks) and frontend handling (reconnect, rehydrate, `undoManager.clear()`, UI controls).

## Dependencies

- **Requires:** Phase 4 complete (status mirror live for post-restore reconciliation)
- **Requires:** Phase 0's `ai_turn` bookmark creation and `BookmarkStore` infrastructure
- **Parallel with:** Phase 5a (thread undo/reapply)

## Files to Modify/Create

| File | Change |
|------|--------|
| New: `backend/internal/service/collab/restore_service.go` | `RestoreService` — restore and undo-restore logic |
| New: `backend/internal/handler/collab_restore.go` | REST handlers for restore endpoints |
| `backend/internal/service/collab/session_manager.go` | Add `Freeze(docID)` and `Rebuild(docID)` methods for session teardown/rebuild during restore |
| `backend/internal/domain/services/collab/collab.go` | Add `RestoreService` interface |
| `backend/cmd/server/main.go` | Wire `RestoreService`, register restore routes |
| `backend/internal/service/collab/proposal_service.go` | Wire `ai_turn` bookmark creation into proposal creation flow (before AI proposals apply) |
| Frontend: dev CM6 route / toy | Handle `document:restored` event: reconnect, rehydrate, `undoManager.clear()`. Thread UI restore/undo-restore buttons. |

## Interface Contracts

### `RestoreService`

```go
type RestoreService interface {
    RestoreTurn(ctx context.Context, turnID uuid.UUID) (*RestoreResult, error)
    UndoRestore(ctx context.Context, turnID uuid.UUID) (*RestoreResult, error)
}

type RestoreResult struct {
    AffectedDocumentIDs []uuid.UUID
}
```

### REST Endpoints

```
POST /api/turns/{id}/restore      → RestoreService.RestoreTurn
POST /api/turns/{id}/undo-restore → RestoreService.UndoRestore
```

Both return `200 { "affected_document_ids": [...] }` on success, `404` if no bookmarks found, `500` on failure.

### SessionManager additions

```go
// Freeze tears down the live session for a document.
// Stops accepting WebSocket updates, drains in-flight mutations.
// Returns a handle for rebuilding after restore completes.
func (m *DocumentSessionManager) Freeze(ctx context.Context, docID string) error

// Rebuild recreates the session from fresh persisted state.
// Called after restore replaces persisted state.
func (m *DocumentSessionManager) Rebuild(ctx context.Context, docID string) error
```

## Restore Flow (Backend)

```go
func (s *RestoreService) RestoreTurn(ctx, turnID) (*RestoreResult, error) {
    // 1. Find all ai_turn bookmarks for this turn
    bookmarks := s.bookmarkStore.ListByTurnID(ctx, turnID)
    if len(bookmarks) == 0 { return nil, ErrNotFound }

    docIDs := unique document IDs from bookmarks
    sort.Strings(docIDs)  // prevent deadlocks

    // 2. Acquire advisory locks for all documents
    for _, docID := range docIDs {
        tx.Exec("SELECT pg_advisory_xact_lock($1)", docID)
    }

    // 3. Freeze all live sessions
    for _, docID := range docIDs {
        s.sessionManager.Freeze(ctx, docID)
    }

    // 4. Create safety_restore bookmarks (idempotent)
    for _, docID := range docIDs {
        currentState := // load current persisted state
        s.bookmarkStore.Create(ctx, &Bookmark{
            DocumentID:   docID,
            State:        currentState,
            BookmarkType: "safety_restore",
            TurnID:       &turnID,
        })  // ON CONFLICT DO NOTHING
    }

    // 5. Replace persisted state for each document
    for _, bookmark := range bookmarks {
        bookmarkState := s.bookmarkStore.GetState(ctx, bookmark.ID)
        // Write new checkpoint from bookmark state
        s.checkpointStore.Create(ctx, bookmark.DocumentID, bookmarkState, 0)
        // Delete post-bookmark update rows
        s.updateLogStore.DeleteUpTo(ctx, bookmark.DocumentID, maxInt64)
    }

    // 6. Broadcast document:restored for each document
    for _, docID := range docIDs {
        s.broadcaster.BroadcastDocumentRestored(docID)
    }

    // 7. Reconcile proposal statuses from restored Y.Map
    for _, docID := range docIDs {
        // Load restored Y.Doc, read _proposal_status, reconcile rows
        s.statusMirror.ReconcileAll(ctx, docID, restoredStatusMap)
    }

    // 8. Release locks, rebuild sessions
    for _, docID := range docIDs {
        s.sessionManager.Rebuild(ctx, docID)
    }

    return &RestoreResult{AffectedDocumentIDs: docIDs}, nil
}
```

## Frontend Restore Handling

### `document:restored` Event

```typescript
ws.on('document:restored', () => {
    // 1. Disconnect Yjs provider
    provider.disconnect();

    // 2. Create fresh Y.Doc
    const newDoc = new Y.Doc();

    // 3. Reconnect provider (rehydrates from backend)
    provider = new WebsocketProvider(url, docId, newDoc);

    // 4. Clear undo stack
    undoManager.clear();

    // 5. Re-derive projection
    derive();
});
```

### Thread UI Controls

```
Before restore:
  [Undo All Accepted]
  [Restore to before this turn]    ← only shown while ai_turn bookmark exists

After restore:
  [Restored] [Undo restore]        ← only shown while safety_restore bookmark exists
  (per-proposal actions hidden — proposals back to pending as diff hunks)
```

Bookmark existence check: query `GET /api/documents/{id}/proposals?turn_id={turnId}` — if all proposals for the turn are `pending`, the restore already happened. The restore/undo-restore button visibility can also be driven by a lightweight API that checks bookmark existence.

## `ai_turn` Bookmark Wiring

In the proposal creation flow (Phase 0 created the `BookmarkStore`, this phase wires the hook):

```go
// In ProposalService.CreateProposal or the mutation strategy:
// Before the first proposal of an AI turn is created, create an ai_turn bookmark
if isFirstProposalInTurn(ctx, turnID, documentID) {
    sessionManager.CreateAITurnBookmark(ctx, documentID, turnID)
}
```

"First proposal in turn" can be detected by checking if any proposals with this `turn_id` and `document_id` already exist.

## Cleanup

| Artifact | Action |
|----------|--------|
| `handler/collab_snapshot.go` + tests | Remove entirely (replaced by restore endpoints) |
| Snapshot REST routes | Remove from `main.go` |
| `SnapshotStore` interface | Remove from `collab.go` (replaced by `BookmarkStore`) |
| Snapshot-related methods on `PostgresDocumentStore` | Remove (`SaveSnapshot`, `ListSnapshots`, `GetSnapshot`, `DeleteSnapshot`, `DeleteExpiredAutoSnapshots`) |

## Verification Criteria

- [ ] `POST /api/turns/{id}/restore` restores all documents with `ai_turn` bookmark for that turn
- [ ] Restore creates `safety_restore` bookmarks before modifying any document
- [ ] Restore is idempotent (`ON CONFLICT DO NOTHING` on safety bookmarks)
- [ ] Restore acquires advisory locks sorted by document ID (no deadlocks)
- [ ] Restore freezes live sessions before replacing persisted state
- [ ] Restore broadcasts `document:restored` event
- [ ] Clients reconnect and rehydrate Y.Doc from fresh persisted state on `document:restored`
- [ ] `undoManager.clear()` is called on all tabs after `document:restored`
- [ ] Proposals from the restored turn return to `pending` (Y.Map entries gone)
- [ ] Status mirror reconciliation runs on restored documents
- [ ] `POST /api/turns/{id}/undo-restore` restores from safety bookmarks
- [ ] Undo-restore follows the same freeze/replace/reconnect flow
- [ ] `ai_turn` bookmark is created before first proposal of each AI turn
- [ ] Thread UI shows `[Restore to before this turn]` only while `ai_turn` bookmark exists
- [ ] Thread UI shows `[Restored] [Undo restore]` after restore, only while `safety_restore` bookmark exists
- [ ] Snapshot handler and routes are removed
- [ ] `go build ./...` passes
