# Phase 1: Work Item Status Filter (Item 14)

## Scope
Thread `?status=` query parameter through handler -> service -> store for work item listing. Empty value = no filter (backwards compatible).

## Files to Modify
- `backend/internal/handler/work_item.go` — read `status` query param, pass to service
- `backend/internal/service/workitem/service.go` — add `status` param to List signature
- `backend/internal/repository/postgres/work_item.go` — add optional WHERE clause to ListByProject

## Interface to Update
- `backend/internal/domain/workitem/interfaces.go` — WorkItemService.List and Store.ListByProject need status param

## Current Behavior
- Handler (line ~147): `h.svc.List(r.Context(), projectID, userID, offset, limit)`
- Service (line ~167): `s.store.ListByProject(ctx, projectID, offset, limit)`
- Store: `WHERE project_id = $1 AND deleted_at IS NULL`
- Valid status values: `"active"`, `"done"` (see domain types)

## Implementation
1. Handler: `status := r.URL.Query().Get("status")` — pass as string, empty means "no filter"
2. Service: add `status string` param, pass through
3. Store: if status non-empty, append `AND status = $N` to both count and list queries
4. Interface: update both `WorkItemService` and `Store` signatures

## Constraints
- Empty/missing status = return all (backwards compatible)
- Invalid status values: just pass through — the DB won't match anything, which is fine (returns empty)
- Don't validate status enum at handler level — keep it simple

## Verification Criteria
- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go vet ./...` passes
- [ ] Existing list behavior unchanged when no status param provided
