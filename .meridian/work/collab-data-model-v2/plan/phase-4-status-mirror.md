# Phase 4: Backend Status Mirror

## Scope and Intent

Backend observes `_proposal_status` Y.Map changes from Yjs sync and mirrors them to proposal rows. Adds full reconciliation on document load as a safety net. Pins Yjs wire format to v1 with JS-Go compatibility tests.

## Dependencies

- **Requires:** Phase 3 complete (frontend writes to `_proposal_status` via accept/reject transactions, old server-side paths removed)

## Files to Modify

| File | Change |
|------|--------|
| `backend/internal/service/collab/session_manager.go` | Add Y.Map observer on `_proposal_status`. On delta: call `StatusMirror.OnStatusChange()`. On document load: call `StatusMirror.ReconcileAll()`. |
| New: `backend/internal/service/collab/status_mirror.go` | `StatusMirror` implementation |
| `backend/internal/repository/postgres/collab/proposal_store.go` | Ensure `UpsertStatus()` handles all status values. Remove `MarkAccepted`, `MarkRejected`, `getCurrentStatus`, `markTerminalStatus`. |
| `backend/internal/domain/services/collab/collab.go` | Add `StatusMirror` interface. Clean up `ProposalStore` (remove old decision methods). |
| `backend/cmd/server/main.go` | Wire `StatusMirror`, inject into session manager |
| New: `backend/internal/service/collab/status_mirror_test.go` | Unit tests |
| New: compatibility test file | JS-Go Yjs wire format tests |

## Interface Contracts

### New `StatusMirror` interface

```go
type StatusMirror interface {
    // Called on each _proposal_status Y.Map delta from Yjs sync
    OnStatusChange(ctx context.Context, proposalID string, newStatus *string) error
    // newStatus == nil means key was deleted (Ctrl-Z of reject → back to pending)

    // Called on document load for full reconciliation
    ReconcileAll(ctx context.Context, documentID string, statusMap map[string]string) error
    // statusMap: proposalID → status from Y.Map
    // Missing keys → pending (except invalid rows, which are skipped)
}
```

### Updated `ProposalStore` (removing old methods)

```go
type ProposalStore interface {
    Create(ctx context.Context, proposal *Proposal) error
    GetByID(ctx context.Context, proposalID uuid.UUID) (*Proposal, error)
    ListByDocument(ctx context.Context, documentID uuid.UUID, status *ProposalStatus, limit int, offset int) ([]Proposal, error)
    UpsertStatus(ctx context.Context, proposalID uuid.UUID, status ProposalStatus) error
    SetAcceptedAtOffset(ctx context.Context, proposalID uuid.UUID, offset int, version int) error
    // REMOVED: MarkAccepted, MarkRejected, ListByGroup, CountByDocumentAndStatusAndSource
}
```

## Key Implementation Notes

### Y.Map observation

In `DocumentSession`, after loading the Y.Doc, observe `_proposal_status`:

```go
proposalStatusMap := s.doc.GetMap("_proposal_status")
proposalStatusMap.Observe(func(event *ycrdt.MapEvent) {
    for _, change := range event.Changes {
        proposalID := change.Key
        if change.Action == "delete" {
            // Key removed (Ctrl-Z of reject) → back to pending
            mirror.OnStatusChange(ctx, proposalID, nil)
        } else {
            newStatus := change.NewValue.(string)
            mirror.OnStatusChange(ctx, proposalID, &newStatus)
        }
    }
})
```

**Note:** Verify `y-crdt` Go library supports `MapEvent` observation with change details. If not, use a poll-based approach: after each Yjs sync update, diff the current Y.Map state against the last-known state.

### Reconciliation on load

```go
func (m *StatusMirror) ReconcileAll(ctx, docID, statusMap) error {
    proposals, _ := m.store.ListByDocument(ctx, docID, nil, 1000, 0)
    for _, p := range proposals {
        if p.Status == StatusInvalid {
            continue  // terminal, never reconciled
        }
        mapStatus, exists := statusMap[p.ID.String()]
        if !exists {
            // Missing key = pending (unless invalid)
            if p.Status != StatusPending {
                m.store.UpsertStatus(ctx, p.ID, StatusPending)
            }
        } else if string(p.Status) != mapStatus {
            m.store.UpsertStatus(ctx, p.ID, ProposalStatus(mapStatus))
        }
    }
    return nil
}
```

### Yjs wire format pinning

- Pin to v1 (`update`/`encodeStateAsUpdate`)
- Reject or gate v2 payloads if/when they exist
- Add JS-Go compatibility tests:
  - Create a Y.Doc in JS, apply text + map updates, encode as update bytes
  - Load those bytes in Go via `y-crdt`, verify same text content and map entries
  - Repeat in reverse: create in Go, verify in JS
  - Test both Y.Text mutations and Y.Map mutations

## Cleanup

| Artifact | Action |
|----------|--------|
| `MarkAccepted()` on ProposalStore | Remove |
| `MarkRejected()` on ProposalStore | Remove |
| `getCurrentStatus()` | Remove |
| `markTerminalStatus()` | Remove |
| `ListByGroup()` on ProposalStore | Remove (proposal_group_id is gone) |
| `CountByDocumentAndStatusAndSource()` | Evaluate — keep if used for analytics, remove if only used by old arbiter |
| `decided_by_user_id`, `decided_at` columns | Remove via migration (decision authority is Yjs) |
| `ProposalDecision` type | Remove if not done in Phase 3 |

## Verification Criteria

- [ ] `_proposal_status` Y.Map changes are mirrored to proposal rows in real-time
- [ ] Key deletion (Ctrl-Z of reject) correctly sets row back to `pending`
- [ ] `accepted`, `rejected`, `stale`, `reverted` statuses are all mirrored correctly
- [ ] Full reconciliation on document load repairs any drift
- [ ] `invalid` proposals are skipped during missing-key reconciliation
- [ ] `stale` proposals may return to `pending` on missing-key reconciliation (non-terminal)
- [ ] JS-Go compatibility tests pass for Y.Text updates
- [ ] JS-Go compatibility tests pass for Y.Map updates
- [ ] No `MarkAccepted`/`MarkRejected` references in code (grep)
- [ ] `decided_by_user_id` and `decided_at` columns removed
- [ ] `go build ./...` passes
