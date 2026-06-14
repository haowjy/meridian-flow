# Phase SP3: Cancellation Cascade + Spawn API Endpoints

## Scope
Implement parent→child cancellation cascade and spawn-related API endpoints.

## Dependencies: SP1

## Files to Create
- `backend/internal/handler/spawn.go`

## Files to Modify
- `backend/internal/service/llm/streaming/stream_executor.go` — on interruption, cascade to children
- `backend/internal/service/llm/streaming/spawn_service.go` — add CancelSpawn, child executor tracking
- `backend/internal/handler/thread.go` — extend thread detail with spawn fields
- `backend/internal/app/domains/llm.go` — wire spawn endpoints

## Key Details
- Cancel parent → walk child threads (via parent_thread_id), cancel their executors
- SpawnService maintains map of running child executors
- API: GET /api/threads/{id}/spawns → list child threads
- Thread detail gains: parent_thread_id, spawn_status, spawn_result, children_count

## Verification Criteria
- [ ] Cancel parent → children cancelled
- [ ] Cancel child → doesn't affect parent
- [ ] Already-completed children not affected
- [ ] Spawn list returns child threads
- [ ] Thread detail includes spawn fields
- [ ] `make test` passes, `go vet ./...` clean
