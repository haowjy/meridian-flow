# Phase 2a: Backend Validation + BuildProjectedState

## Scope and Intent

Backend half of the projection pipeline. Three responsibilities:
1. Validate `yjs_update` payloads at proposal creation time (reject invalid mutations)
2. Bootstrap `_proposal_status` Y.Map in canonical docs
3. Refactor `BuildProjectedState` to be per-user and parity-tested against the frontend projection

This phase runs **in parallel** with Phase 2b (frontend projection). Both must pass golden parity tests before the round commits.

## Dependencies

- **Requires:** Phase 1 complete (proposal columns, `pending` status, `ai_content` removed)
- **Parallel with:** Phase 2b (frontend projection pipeline)

## Files to Modify

| File | Change |
|------|--------|
| `backend/internal/service/collab/ai_content_projector.go` | Rename to `projected_state_builder.go`. Remove `Recompute()`. Refactor `BuildProjectedState()` to accept `userID` parameter. Remove all `ai_content` column writes. |
| `backend/internal/service/collab/ai_content_projector_test.go` | Rename to `projected_state_builder_test.go`. Update tests. |
| `backend/internal/domain/services/collab/collab.go` | Remove `AIContentProjector` interface. Update `ProjectedStateBuilder` to `BuildProjectedState(ctx, documentID, userID)`. |
| `backend/internal/service/collab/session_manager.go` | Add `BootstrapProposalStatusMap()` — ensure `_proposal_status` Y.Map exists in canonical on load. |
| `backend/internal/service/collab/yjs_text_converter.go` | Add `ValidateYjsUpdate()` — validate that update only touches `Y.Text('content')`. |
| `backend/internal/service/collab/proposal_service.go` | Add validation call in `CreateProposal()`. Reject with `invalid` status on failure. |
| `backend/internal/service/llm/tools/mutation_strategy_collab.go` | Update `projectedStateBuilder` usage to pass `userID`. |
| `backend/cmd/server/main.go` | Update wiring for renamed projector. |
| New: `backend/internal/service/collab/projected_state_builder_parity_test.go` | Golden parity tests |

## Interface Contracts

### Updated `ProjectedStateBuilder`

```go
type ProjectedStateBuilder interface {
    // userID scopes which pending proposals are applied.
    // Only proposals where created_by_user_id == userID are included.
    BuildProjectedState(ctx context.Context, documentID uuid.UUID, userID uuid.UUID) ([]byte, error)
}
```

### New validation function

```go
// ValidateYjsUpdate checks that the update only modifies Y.Text('content').
// Returns error if the update touches Y.Map or Y.Array shared types.
func ValidateYjsUpdate(canonical []byte, update []byte) error
```

Implementation approach:
1. Create a test doc, apply canonical state
2. Ensure `_proposal_status` Y.Map exists (bootstrap it if missing)
3. Apply the update to the test doc
4. Check `Transaction.Changed` — if any shared type other than `Y.Text('content')` was modified, return error
5. **Fallback if y-crdt Go doesn't support `Transaction.Changed`:** Compare Y.Map and Y.Array state before/after apply

### Validation in CreateProposal

```go
func (s *ProposalService) CreateProposal(ctx, req) (*Proposal, error) {
    // ... existing logic ...

    // NEW: validate yjs_update
    canonicalState, err := s.proposalRuntime.GetStateSnapshot(ctx, req.DocumentID)
    if err != nil { return nil, err }

    if err := ValidateYjsUpdate(canonicalState, req.YjsUpdate); err != nil {
        proposal.Status = ProposalStatusInvalid
        // Store but don't broadcast
        s.proposalStore.Create(ctx, proposal)
        return proposal, nil
    }

    // ... continue with normal creation ...
}
```

## Key Implementation Notes

### `_proposal_status` Y.Map bootstrap

In `SessionManager.loadState()` (or `Acquire`), after loading/replaying the Y.Doc:
```go
// Ensure _proposal_status exists so validation can detect unexpected mutations
doc.GetMap("_proposal_status")  // auto-creates if missing in y-crdt
```

This is critical for validation — if the map doesn't exist yet, a malicious update that creates it would evade the `Transaction.Changed` check.

### Per-user projection

Current `BuildProjectedState` lists ALL pending proposals. Change to filter by `userID`:
```go
proposals, err := s.proposalStore.ListByDocument(ctx, docID, &statusPending, 100, 0)
// Filter to only this user's proposals
var userProposals []Proposal
for _, p := range proposals {
    if p.CreatedByUserID == userID {
        userProposals = append(userProposals, p)
    }
}
```

Or add a new store method: `ListByDocumentAndUser(ctx, docID, userID, status)`.

### Parity tests

Golden tests that verify backend `BuildProjectedState` matches frontend projection for the same inputs:
1. Create a canonical Y.Doc with known content
2. Create N proposals with known `yjs_update` bytes
3. Run `BuildProjectedState` on the backend (Go)
4. Run the equivalent clone+apply+extract on the frontend (JS, via test harness)
5. Assert identical text output

These tests can use the `toy/yjs-spec-tests.mjs` infrastructure to generate the JS side.

## Cleanup

| Artifact | Action |
|----------|--------|
| `ai_content_projector.go` | Rename to `projected_state_builder.go` |
| `ai_content_projector_test.go` | Rename to `projected_state_builder_test.go` |
| `AIContentProjector` interface | Remove from `collab.go` |
| `Recompute()` method | Remove entirely |
| All `ai_content` writes in projector | Remove |
| `collab_request_idempotency` table | Drop (no server-side accept/reject idempotency needed) |
| `IdempotencyStore` interface + implementation | Remove |
| `idempotency_store.go` | Remove entirely |

## Verification Criteria

- [ ] `projected_state_builder.go` exists (renamed from `ai_content_projector.go`)
- [ ] No `AIContentProjector` interface references (grep)
- [ ] No `Recompute()` method references (grep)
- [ ] No `ai_content` column writes in projector code
- [ ] `BuildProjectedState(ctx, documentID, userID)` accepts userID parameter
- [ ] Per-user filtering: only proposals where `created_by_user_id == userID` are applied
- [ ] `ValidateYjsUpdate()` rejects updates that modify `_proposal_status` Y.Map
- [ ] `ValidateYjsUpdate()` rejects updates that modify `Y.Array('_comments')`
- [ ] `ValidateYjsUpdate()` allows updates that only modify `Y.Text('content')`
- [ ] `CreateProposal()` calls validation; invalid proposals stored with `status = 'invalid'`
- [ ] `_proposal_status` Y.Map is bootstrapped on document load
- [ ] `collab_request_idempotency` table is dropped
- [ ] No `IdempotencyStore` references in code (grep)
- [ ] Golden parity tests pass (backend projection == frontend projection for same inputs)
- [ ] `go build ./...` passes
