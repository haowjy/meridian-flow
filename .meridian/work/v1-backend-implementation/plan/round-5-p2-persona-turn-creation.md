# Phase P2: Persona → Turn Creation Integration

## Scope
Integrate persona resolution into the turn creation pipeline. Add work item lifecycle gates.

## Risk: CRITICAL — modifying the core turn creation path

## Dependencies: P1, A5a, A5b, R1, R2

## Files to Create
- `backend/migrations/00037_add_thread_persona.sql` — persona column on threads

## Files to Modify
- `backend/internal/domain/llm/thread.go` — add Persona field
- `backend/internal/domain/llm/streaming_service.go` — add persona to CreateTurnRequest
- `backend/internal/service/llm/streaming/turn_creation.go` — add PersonaCatalog + WorkItemService + contextResolver to pipeline
- `backend/internal/service/llm/streaming/gather_context.go` — persona resolution, work item gate, context variable resolution
- `backend/internal/service/llm/streaming/service.go` — add deps to StreamingDeps
- `backend/internal/repository/postgres/llm/thread.go` — persist/read persona

## Key Details
- gatherContext stage gains: persona resolution, work item lifecycle gate, context variable resolution
- Turn with persona slug → resolve via PersonaCatalog
- Invalid persona → 422 with PERSONA_NOT_FOUND
- Turn on done/deleted work item → 409 with WORK_ITEM_DONE/WORK_ITEM_DELETED
- Legacy thread (no work item) → ephemeral auto-provisioned via EnsureThreadWorkItem
- Cold-start with persona → thread created with persona field
- All existing non-persona turns MUST still work unchanged

## Verification Criteria
- [ ] Turn with persona slug → persona resolved
- [ ] Invalid persona → 422
- [ ] Turn on done work item → 409
- [ ] Legacy thread (no work item) → ephemeral auto-provisioned
- [ ] Cold-start with persona → thread created with persona
- [ ] All existing non-persona turns still work (regression)
- [ ] `make test` passes, `go vet ./...` clean
