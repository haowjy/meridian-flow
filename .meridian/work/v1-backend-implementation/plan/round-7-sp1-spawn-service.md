# Phase SP1: Spawn Service + Child Thread Bootstrap + Graceful Shutdown

## Risk: CRITICAL

## Scope
Create SpawnService for foreground spawning, ChildThreadBootstrapper for child thread creation, and ShutdownCoordinator for graceful shutdown.

## Files to Create
- `backend/internal/service/llm/streaming/spawn_service.go` — SpawnService + ChildThreadBootstrapper
- `backend/internal/service/llm/streaming/spawn_service_test.go`
- `backend/internal/domain/llm/spawn.go` — SpawnRequest, SpawnResult, SpawnInvoker interface
- `backend/internal/service/llm/streaming/shutdown.go` — graceful shutdown coordinator
- `backend/migrations/00039_add_thread_spawn_fields.sql` — parent_thread_id, spawn_status, spawn_result, spawn_depth

## Files to Modify
- `backend/internal/domain/llm/thread.go` — add ParentThreadID, SpawnStatus, SpawnResult, SpawnDepth
- `backend/internal/repository/postgres/llm/thread.go` — persist/read spawn fields

## Key Details
- SpawnService.CreateSpawn: validate limits, resolve persona, create child thread, create initial user turn, start streaming, block on completion channel (foreground)
- spawn_timeout: 5 minutes via context.WithTimeout
- spawn_depth: denormalized on thread row — parent.spawn_depth + 1, O(1) check
- ChildThreadBootstrapper: extracted from CreateTurn path — creates thread + initial turns + starts streaming
- SpawnInvoker: narrow interface for circular dep resolution
- SpawnResult: extracted from child thread's final turn
- ShutdownCoordinator: tracks active executors + spawn channels. SIGTERM → stop new turns, wait 30s, cascade-cancel
- DB constraint: parent_thread_id != id (prevent self-referential)

## Verification Criteria
- [ ] Foreground spawn creates child thread with parent_thread_id
- [ ] Child inherits work_item_id
- [ ] Child streams with persona
- [ ] Foreground spawn blocks until child completes
- [ ] spawn_depth denormalized correctly (parent+1)
- [ ] Spawn times out after 5 minutes
- [ ] Graceful shutdown waits for active streams
- [ ] `make test` passes, `go vet ./...` clean
