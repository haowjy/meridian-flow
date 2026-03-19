# Phase 1: Schema Housekeeping

## Scope and Intent

Prepare the proposal table for v2 semantics: new columns, renamed statuses, offset persistence endpoint. Remove `ai_content` from the documents table. This is low-risk schema prep that unblocks the projection pipeline (Phase 2).

## Dependencies

- **Requires:** Phase 0 complete (append-only persistence live, `yjs_state` column removed)

## Files to Modify

| File | Change |
|------|--------|
| `backend/migrations/` (new) | Add proposal columns, rename status, remove `ai_content` |
| `backend/internal/domain/models/collab/proposal.go` | Add new fields (`RegionTextBefore`, `RegionTextAfter`, `ProposedAtOffset`, `AcceptedAtOffset`, `OffsetVersion`). Add new status constants (`Pending`, `Stale`, `Reverted`, `Invalid`). Rename `Proposed` → `Pending`. |
| `backend/internal/repository/postgres/collab/proposal_store.go` | Update `Create` to write new columns. Add `UpsertStatus()` and `SetAcceptedAtOffset()` methods. Update column mappings. |
| `backend/internal/domain/services/collab/collab.go` | Update `ProposalStore` interface with new methods. Update `CreateProposalRequest` with new fields. |
| `backend/internal/handler/collab_proposal.go` | Add `handleSetAcceptedAtOffset()` handler |
| `backend/cmd/server/main.go` | Register offset endpoint route |
| `backend/internal/service/llm/tools/mutation_strategy_collab.go` | Add `RegionTextBefore`, `RegionTextAfter`, `ProposedAtOffset` to `CreateProposalRequest` in `Apply()` |

## Schema Migration

```sql
-- Rename status value
UPDATE ${TABLE_PREFIX}collab_document_edit_proposals SET status = 'pending' WHERE status = 'proposed';

-- Extend status CHECK
ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    DROP CONSTRAINT collab_document_edit_proposals_status_check,
    ADD CONSTRAINT collab_document_edit_proposals_status_check
        CHECK (status IN ('pending', 'accepted', 'rejected', 'stale', 'reverted', 'invalid'));

-- Add new columns
ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    ADD COLUMN region_text_before TEXT,
    ADD COLUMN region_text_after TEXT,
    ADD COLUMN proposed_at_offset INT,
    ADD COLUMN accepted_at_offset INT,
    ADD COLUMN offset_version INT NOT NULL DEFAULT 0;

-- Remove ai_content
ALTER TABLE ${TABLE_PREFIX}documents DROP COLUMN IF EXISTS ai_content;
```

## Interface Contracts

### New/modified on `ProposalStore`

```go
// NEW: status mirror upsert (from Yjs sync deltas, Phase 4)
UpsertStatus(ctx context.Context, proposalID uuid.UUID, status ProposalStatus) error

// NEW: offset persistence with monotonic version guard
SetAcceptedAtOffset(ctx context.Context, proposalID uuid.UUID, offset int, version int) error
```

### `SetAcceptedAtOffset` semantics

```sql
UPDATE proposals
SET accepted_at_offset = $2, offset_version = $3
WHERE id = $1 AND offset_version < $3
```

Returns the number of rows affected. If 0, the request had a stale version — silently ignore (monotonic guard).

### New fields on `CreateProposalRequest`

```go
type CreateProposalRequest struct {
    // ... existing fields ...
    RegionTextBefore  *string  // from edit_document find param
    RegionTextAfter   *string  // from edit_document replacement param
    ProposedAtOffset  *int     // character offset in canonical
}
```

### Offset endpoint

```
PATCH /api/proposals/{id}/offset
Body: { "accepted_at_offset": 42, "offset_version": 3 }
Response: 200 OK | 404 Not Found
```

## Pattern Reference

- Follow existing `handler/collab_proposal.go` patterns for the new endpoint
- Follow existing proposal store column mapping patterns in `PostgresProposalStore`

## Key Implementation Notes

### Mutation strategy changes

In `CollabProposalStrategy.Apply()`:
- After `FindEditPosition()` succeeds, capture `position` as `proposedAtOffset`
- `input.OldContent` becomes `regionTextBefore`
- `input.NewContent` (the replacement portion) becomes `regionTextAfter`
- Pass all three in `CreateProposalRequest`

### ai_content removal

- Remove `ai_content` from `SaveState()` call in `session_manager.go` (if not already removed in Phase 0)
- Remove `AIContentReader` interface usage
- Remove `LoadAIContent()` from `PostgresDocumentStore`
- Remove any consumer that reads `documents.ai_content` (search for `ai_content` in backend/)
- **Transition:** `AIContentProjector.Recompute()` currently writes `ai_content`. In this phase, just stop writing it. The `BuildProjectedState()` path survives (Phase 2 refactors it).

## Cleanup

| Artifact | Action |
|----------|--------|
| `documents.ai_content` column | Drop via migration |
| `AIContentReader` interface | Remove from `collab.go` |
| `LoadAIContent()` method | Remove from `PostgresDocumentStore` |
| `ai_content` parameter in `SaveState()` | Remove (signature change, update all callers) |
| Status value `proposed` | Renamed to `pending` everywhere (models, store, tests) |

## Verification Criteria

- [ ] Proposal table has `region_text_before`, `region_text_after`, `proposed_at_offset`, `accepted_at_offset`, `offset_version` columns
- [ ] Proposal status CHECK includes `pending`, `accepted`, `rejected`, `stale`, `reverted`, `invalid`
- [ ] No `proposed` status references in code (grep: `"proposed"` in proposal context)
- [ ] `documents` table has no `ai_content` column
- [ ] No `ai_content` references in backend code (grep: `ai_content`, excluding comments/docs)
- [ ] `PATCH /api/proposals/{id}/offset` endpoint works with monotonic version guard
- [ ] `CollabProposalStrategy.Apply()` populates `region_text_before`, `region_text_after`, `proposed_at_offset`
- [ ] `go build ./...` passes
- [ ] Existing tests pass (adapted for schema changes)
