# Phase A4b: Work Item Service + Handler + Thread Integration

## Scope
Create the work item service (business logic), HTTP handler (REST endpoints), and integrate with thread creation for ephemeral auto-provisioning.

## Intent
Makes work items usable: CRUD endpoints, lifecycle management (complete/reopen/delete), and automatic ephemeral work item creation when threads are created without one.

## Dependencies
- A4a must complete first (domain types, store, migrations)
- ERR (error codes) for structured errors

## Files to Create
- `backend/internal/service/workitem/service.go` — business logic
- `backend/internal/service/workitem/service_test.go` — unit tests
- `backend/internal/handler/work_item.go` — REST endpoints
- `backend/internal/app/domains/workitem.go` — wiring module

## Files to Modify
- `backend/internal/service/llm/thread/service.go` — add WorkItemService dependency, ephemeral creation on thread create
- `backend/internal/domain/llm/thread.go` — add WorkItemID field
- `backend/internal/repository/postgres/llm/thread_store.go` — persist/read work_item_id
- `backend/internal/handler/thread.go` — add work_item_id filter to thread list response

## Service Methods
- Create(ctx, projectID, userID, name, ephemeral) (*WorkItem, error) — with slug generation + retry-on-collision
- Get(ctx, projectID, idOrSlug, userID) (*WorkItem, error)
- List(ctx, projectID, userID, offset, limit) ([]WorkItem, int, error)
- Update(ctx, projectID, id, userID, updates) (*WorkItem, error)
- Complete(ctx, projectID, id, userID) error — checks no streaming threads, sets status=done
- Reopen(ctx, projectID, id, userID) error
- Delete(ctx, projectID, id, userID) error — soft delete
- EnsureThreadWorkItem(ctx, projectID, threadID, userID) (*WorkItem, error) — create ephemeral if thread has none, check cap
- AttachThread(ctx, threadID, workItemID) error

## Slug Generation
Generate from name: lowercase, replace spaces with hyphens, strip non-alphanum. On collision, append -2, -3, etc.

## HTTP Endpoints
- POST   /api/projects/{id}/work-items — create
- GET    /api/projects/{id}/work-items — list (with ?status filter)
- GET    /api/projects/{id}/work-items/{slug} — get by slug
- PUT    /api/projects/{id}/work-items/{slug} — update
- POST   /api/projects/{id}/work-items/{slug}/complete — complete
- POST   /api/projects/{id}/work-items/{slug}/reopen — reopen
- DELETE /api/projects/{id}/work-items/{slug} — soft delete

## Error Handling (use domain/errors)
- Complete while streaming → 409 with WORK_ITEM_DONE error code
- Turn on done work item → 409 with WORK_ITEM_DONE
- Turn on deleted work item → 409 with WORK_ITEM_DELETED
- Ephemeral cap exceeded → appropriate error

## Thread Integration
In thread service CreateThread (or wherever threads are created):
- If no work_item_id provided, call EnsureThreadWorkItem
- EnsureThreadWorkItem checks CountActiveEphemerals < 100, creates if under cap
- If at cap, reuse most recent ephemeral work item

## Patterns to Follow
- See `backend/internal/service/docsystem/document.go` for ExecTx pattern
- See `backend/internal/handler/thread.go` for handler conventions
- See `backend/internal/app/domains/` for wiring pattern
- See `backend/internal/domain/errors/` for structured error usage

## Verification Criteria
- [ ] `make test` passes
- [ ] Create work item → artifact folder concept exists (slug-based)
- [ ] Slug collision → auto-increment (-2, -3)
- [ ] Complete while streaming → 409 with WORK_ITEM_DONE error code
- [ ] Thread created without work_item_id → ephemeral auto-created
- [ ] Ephemeral cap (100) enforced
- [ ] All 7 HTTP endpoints return correct status codes
- [ ] `go vet ./...` clean
