# Phase 2, Item 1: Replace SetSpawnInvoker type assertion with callback

## Scope
Replace the brittle anonymous interface type assertion used to wire SpawnInvoker into StreamingService with a `SpawnInvokerRef` callback in `StreamingDeps`. This eliminates a post-construction mutation and the only anonymous type assertion in the wiring code.

## Problem
`setup.go:213-217` uses:
```go
if svc, ok := streamingService.(interface {
    SetSpawnInvoker(domainllm.SpawnInvoker)
}); ok {
    svc.SetSpawnInvoker(spawnSvc)
}
```

This is fragile — if the method signature changes, the type assertion silently fails and spawn_agent is never registered. It's also the only field set after construction, violating the "validate all deps at construction" pattern.

## Approach
1. Add `SpawnInvokerRef func() domainllm.SpawnInvoker` to `ServiceDeps` (optional, like PersonaCatalog)
2. In `NewStreamingOrchestrator`, store the callback on the Service struct as `spawnInvokerRef`
3. Where the service uses `s.spawnInvoker` (only `launch_stream.go:185`), change to call `s.spawnInvokerRef()` with a nil check
4. In `setup.go`, create a ref-holding closure:
   ```go
   var spawnInvoker domainllm.SpawnInvoker
   // ... pass func() domainllm.SpawnInvoker { return spawnInvoker } in ServiceDeps ...
   // ... after creating spawnSvc:
   spawnInvoker = spawnSvc
   ```
5. Remove `SetSpawnInvoker` method from Service
6. Remove the `spawnInvoker domainllm.SpawnInvoker` field (replaced by `spawnInvokerRef`)

## Files to Modify
- `backend/internal/service/llm/streaming/deps.go` — add `SpawnInvokerRef` to ServiceDeps
- `backend/internal/service/llm/streaming/service.go` — replace `spawnInvoker` field with `spawnInvokerRef`, remove `SetSpawnInvoker` method, update constructor
- `backend/internal/service/llm/streaming/launch_stream.go` — change `svc.spawnInvoker` → `svc.spawnInvokerRef()` (line 185)
- `backend/internal/service/llm/setup.go` — replace type assertion with closure wiring

## Interface Contract
`SpawnInvokerRef func() domainllm.SpawnInvoker` — called lazily when building tool registry. Returns nil before SpawnService is wired (which is fine — the builder already handles nil spawn invoker by not registering the tool).

## Verification Criteria
- [ ] `cd backend && go build ./...` compiles
- [ ] `cd backend && go vet ./...` passes
- [ ] No type assertions on streamingService remain in setup.go
- [ ] `SetSpawnInvoker` method is fully removed
- [ ] `grep -r "SetSpawnInvoker" backend/` returns nothing
