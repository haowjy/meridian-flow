# Phase R1: Cold-Start Reorder + 4-Stage Pipeline Decomposition

## Scope
Refactor the 929-line `turn_creation.go` into a 4-stage pipeline and fix the cold-start ordering bug where `resolveSystemPromptForParams()` is called with `threadID=""` because the thread hasn't been created yet.

## Intent
Every subsequent step (personas, work items, spawning) needs threadID to exist before prompt resolution. This is the foundational refactor that unblocks everything else.

## Files to Modify
- `backend/internal/service/llm/streaming/turn_creation.go` — decompose `CreateTurn` into pipeline orchestrator (<200 lines remaining)

## Files to Create
- `backend/internal/service/llm/streaming/gather_context.go` — stage 1: resolve thread, work item, persona
- `backend/internal/service/llm/streaming/assemble_prompt.go` — stage 2: build tool registry, resolve system prompt
- `backend/internal/service/llm/streaming/persist_turns.go` — stage 3: ExecTx for turns
- `backend/internal/service/llm/streaming/launch_stream.go` — stage 4: start streaming executor

## What Changes

### Cold-start fix
Currently on cold-start (new thread): system prompt is resolved BEFORE the thread is created in ExecTx. This means `resolveSystemPromptForParams()` gets `threadID=""`.

**Target flow**: Move `ExecTx` (thread creation) into `gatherContext` stage so thread exists before `assemblePrompt` runs. On cold-start: create thread first (in gatherContext), then resolve prompt (in assemblePrompt).

### Pipeline decomposition
Each stage is a method on a `turnPipeline` struct, testable in isolation:

```
gatherContext -> assemblePrompt -> persistTurns -> launchStream
```

1. `gatherContext`: resolve thread (or create on cold-start), resolve work item, resolve persona (stubbed for now — P2 adds real logic)
2. `assemblePrompt`: build tool registry, resolve system prompt via `resolveSystemPromptForParams`
3. `persistTurns`: ExecTx for user/assistant turns (NOT thread creation — that moved to gatherContext)
4. `launchStream`: start streaming executor, return response channel

`CreateTurn` becomes the orchestrator calling stages in order.

### turnPipeline struct
Holds the per-request state that flows between stages. Fields: resolved thread, tool registry, system prompt, created turns, etc. Replaces the local variables currently scattered through CreateTurn.

## Constraints
- Do NOT change any external interfaces (CreateTurn signature, StreamingService interface)
- Do NOT change the streaming executor or how streaming works
- Existing thread (warm-start) path must produce identical behavior
- Cold-start path must produce identical behavior except threadID is now valid during prompt resolution
- Each pipeline stage should be independently testable (accept inputs, return outputs)

## Patterns to Follow
- See `streaming/service.go` for how StreamingDeps packages dependencies
- See `domain/llm/streaming_service.go` for the CreateTurn interface

## Verification Criteria
- [ ] `make test` passes
- [ ] Cold-start turn creation still works (smoke test: create turn with only projectID)
- [ ] Existing thread turn creation unchanged
- [ ] Thread has valid ID before prompt resolution on cold-start
- [ ] Debug endpoint produces identical provider requests for same inputs
- [ ] Each pipeline stage is independently testable
- [ ] `turn_creation.go` reduced to pipeline orchestration (<200 lines)
- [ ] `go vet ./...` clean
