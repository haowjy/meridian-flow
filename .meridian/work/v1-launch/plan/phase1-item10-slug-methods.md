# Phase 1: Slug-Based Work Item Service Methods (Item 10)

## Scope
Add slug-based mutation methods to the work item service to eliminate the double fetch pattern (slug -> UUID lookup, then UUID -> operation).

## Files to Modify
- `backend/internal/domain/workitem/interfaces.go` — add slug-based methods to WorkItemService interface
- `backend/internal/service/workitem/service.go` — implement slug-based methods
- `backend/internal/repository/postgres/work_item.go` — add store methods that operate by slug
- `backend/internal/handler/work_item.go` — switch handler to call slug-based service methods directly

## Current Pattern (handler does double fetch)
```go
// Handler: slug -> GetBySlug -> use existing.ID -> Update(id, ...)
existing, err := h.svc.GetBySlug(r.Context(), projectID, userID, slug)
wi, err := h.svc.Update(r.Context(), existing.ID, userID, &req)
```

## Target Pattern
```go
// Handler: slug -> UpdateBySlug(projectID, userID, slug, &req)
wi, err := h.svc.UpdateBySlug(r.Context(), projectID, userID, slug, &req)
```

## Methods to Add
- `UpdateBySlug(ctx, projectID, userID, slug string, req *UpdateRequest) (*WorkItem, error)`
- `CompleteBySlug(ctx, projectID, userID, slug string) (*WorkItem, error)`
- `ReopenBySlug(ctx, projectID, userID, slug string) (*WorkItem, error)`
- `DeleteBySlug(ctx, projectID, userID, slug string) error`

## Store Methods
Add corresponding store methods that resolve slug in the same query:
- `GetBySlugForUpdate(ctx, projectID, slug string) (*WorkItem, error)` — or just use existing GetBySlug and keep the service doing auth + mutation in one call without the handler double-fetch

Actually, the simpler approach: the service methods can internally call `GetBySlug` + the mutation in one method. The point is moving the slug resolution from the handler into the service so the handler doesn't do the double fetch. The store can stay as-is.

## Constraints
- Keep existing UUID-based methods (other internal callers may use them)
- Authorization checks must still happen (service handles this)
- The slug-based methods should have the same error behavior as the current pattern

## Verification Criteria
- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go vet ./...` passes
- [ ] Handler no longer does GetBySlug + separate mutation call
- [ ] All 4 mutation endpoints (update, complete, reopen, delete) use slug-based service methods
