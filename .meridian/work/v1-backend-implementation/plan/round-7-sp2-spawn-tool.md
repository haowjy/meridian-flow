# Phase SP2: spawn_agent Tool + Spawn Limits

## Scope
Create the spawn_agent tool that LLMs can call to spawn child agents. Enforce depth and concurrency limits.

## Dependencies: SP1

## Files to Create
- `backend/internal/service/llm/tools/spawn_agent.go`
- `backend/internal/service/llm/tools/spawn_agent_test.go`

## Files to Modify
- `backend/internal/service/llm/tools/builder.go` — add WithSpawnTool
- `backend/internal/service/llm/tools/metadata.go` — add SpawnAgentToolMetadata
- `backend/internal/service/llm/streaming/turn_creation.go` — wire spawn tool when work item exists

## Key Details
- SpawnAgentTool: input schema {agent: string, prompt: string}. Foreground only.
- Tool registered only when thread has work item and spawn service available
- Spawn limits: depth < 3, concurrent per work item < 5 (SELECT FOR UPDATE)
- Uses SpawnInvoker (narrow interface) to avoid circular deps

## Verification Criteria
- [ ] Tool registered when work item exists
- [ ] Valid spawn → child thread created, result returned
- [ ] Depth 3 → rejected with SPAWN_DEPTH_EXCEEDED
- [ ] 5 concurrent → 6th rejected with SPAWN_LIMIT_EXCEEDED
- [ ] `make test` passes, `go vet ./...` clean
