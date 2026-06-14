# Phase 5b: First-Class SwitchStream

## Scope
Replace the `CreateStreamSwitchFn` callback pattern (which re-enters the full 4-stage CreateTurn pipeline) with a direct `StreamRuntime.SwitchStream()` method that atomically transfers stream slots. Fixes N+1 slot pressure bug and interjection race at stream limit.

## Files to Modify
- `stream_runtime.go` — Add `SwitchStream()` method and `SwitchStreamInput` struct, add `persistSwitchTurns()` helper, delete `CreateStreamSwitchFn()` factory method
- `stream_executor.go` — Replace `streamSwitchFn StreamSwitchFn` field with `streamRuntime *StreamRuntime` reference; remove `StreamSwitchFn` type and `StreamSwitchResult` type (move `StreamSwitchResult` to stream_runtime.go); update `NewStreamExecutor` constructor signature
- `tool_executor.go` — Update INTERJECTION POINT A to call `se.streamRuntime.SwitchStream()` instead of `se.streamSwitchFn()`
- `completion_handler.go` — Update INTERJECTION POINT B to call `se.streamRuntime.SwitchStream()` instead of `se.streamSwitchFn()`
- `launch_stream.go` — Remove `StreamSwitchFn` from `LaunchInput`, remove `CreateStreamSwitchFn` call. Pass `streamRuntime` reference to Launch instead.

## Dependencies
- Requires: Phase 5a (Unified Terminate) — already committed at `cd80586`
- `Terminate(ReasonStreamSwitch, TerminateOpts{})` is called by both interjection points after SwitchStream returns

## Design Reference
Full design: `.meridian/work/v1-launch/plan/phase5-streaming-hardening-design.md` section "Refactor 2: First-Class SwitchStream"

## Key Design Decisions

### Slot transfer mechanism
The new executor gets `nil` for `releaseStreamSlot` in `Launch()`. The OLD executor's `Terminate(ReasonStreamSwitch)` must NOT release the slot. The new executor's cleanup callback inherits the slot release responsibility.

**Critical**: The `onCleanup` callback wired by `Launch()` currently always releases the slot. For stream switch, the OLD executor's cleanup should skip slot release (slot was transferred). The NEW executor's cleanup should release the slot. This means:
- `SwitchStream` calls `Launch(ctx, input, releaseStreamSlot)` passing the ORIGINAL slot release function from the caller's context
- The old executor's `Terminate(ReasonStreamSwitch)` fires `onCleanup` which does registry removal but must NOT release the slot
- Solution: `SwitchStream` must modify the old executor's cleanup to remove slot release before calling `Terminate`, OR handle cleanup of old executor manually within `SwitchStream` itself

### persistSwitchTurns
Lightweight version of stage 3 turn persistence. Creates:
1. A user turn with `prev_turn_id = currentAssistantTurnID`, role "user", containing the interjection text
2. An assistant turn with `prev_turn_id = userTurnID`, role "assistant", status "pending"

Uses `executorDeps.TurnWriter` for persistence. Does NOT need thread resolution, persona, model selection, etc.

### Recursive switch
The new executor also needs the ability to switch streams (if another interjection arrives during its execution). Since the executor now holds a `*StreamRuntime` reference instead of a callback, recursive switching works automatically — the new executor calls `se.streamRuntime.SwitchStream()` the same way.

### What to delete
- `StreamSwitchFn` type definition (stream_executor.go)
- `StreamSwitchResult` type definition (stream_executor.go) — move to stream_runtime.go
- `CreateStreamSwitchFn()` method (stream_runtime.go)
- `StreamSwitchFn` field in `LaunchInput` (stream_runtime.go)
- `streamSwitchFn` field in `StreamExecutor` (stream_executor.go)
- The `streamSwitchFn` parameter in `NewStreamExecutor` constructor

### What to add
- `streamRuntime *StreamRuntime` field on `StreamExecutor`
- `SwitchStreamInput` struct on stream_runtime.go
- `SwitchStream()` method on `StreamRuntime`
- `persistSwitchTurns()` helper on `StreamRuntime`
- `SetStreamRuntime(*StreamRuntime)` or pass via constructor

## Interface Contracts

```go
// SwitchStreamInput captures request-scoped data for atomic stream switch.
type SwitchStreamInput struct {
    CurrentTurnID    string
    ThreadID         string
    UserID           string
    ProjectID        string
    Model            string
    Provider         string
    Params           *domainllm.RequestParams
    ToolRegistry     *tools.ToolRegistry
    SettlementMode   billing.CreditSettlementMode
    InterjectionText string
    Reason           string // "tool_boundary" or "no_tools_completion"
    ReleaseSlot      func() // Slot release function transferred from old executor
}

// StreamSwitchResult (moved from stream_executor.go)
type StreamSwitchResult struct {
    UserTurn      any
    AssistantTurn any
    StreamURL     string
}
```

## Verification Criteria
- [ ] `cd backend && go build ./...` compiles cleanly
- [ ] `cd backend && go vet ./...` passes
- [ ] `cd backend && make test` passes (existing tests)
- [ ] `StreamSwitchFn` type no longer exists in the codebase
- [ ] `CreateStreamSwitchFn` method no longer exists
- [ ] Both interjection points call `se.streamRuntime.SwitchStream()`
- [ ] `NewStreamExecutor` no longer accepts `streamSwitchFn` parameter
- [ ] Stream switch does NOT call `UserStreamTracker.Acquire`
- [ ] New executor's cleanup releases the slot; old executor's cleanup does not
