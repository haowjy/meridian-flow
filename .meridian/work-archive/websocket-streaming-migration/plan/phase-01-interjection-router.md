# Phase 1: InterjectionRouter Interface + SwitchStream Atomicity

## Scope

Extract an `InterjectionRouter` interface from the concrete `mstream.InterjectionBuffer` + `mstream.InterjectionRegistry` dependencies (R4). Wrap the existing behavior behind a thin adapter so all call sites use the interface. Simultaneously fix `SwitchStream` atomicity (R10) since both changes touch the same files.

After this phase, the streaming service layer talks to `InterjectionRouter` instead of concrete mstream types. The adapter preserves existing behavior — no new forwarder logic yet (that's Phase 2).

## What's Out of Scope

- InterjectionForwarder implementation (Phase 2)
- StreamURL removal (Phase 2)
- StreamExecutor config struct refactoring (Phase 2)
- Any wsutil/WS handler work

## Prerequisites

None — this is a Round 1 phase.

## Files to Create

- `backend/internal/service/llm/streaming/interjection_router.go` — Interface definition + adapter wrapping existing InterjectionRegistry/InterjectionBuffer

```go
// InterjectionRouter abstracts interjection routing for both HTTP and WS paths.
// v1 adapter wraps the existing InterjectionRegistry + InterjectionBuffer.
// Phase 2 replaces the adapter with InterjectionForwarder (epoch fencing, forwarding chain).
type InterjectionRouter interface {
    Route(turnID, content, mode string) (targetTurnID string, held bool, err error)
    BeginDrain(turnID string) (epoch uint64, drained string, ok bool)
    CompleteDrain(turnID string, epoch uint64, newTurnID string) (late string, ok bool)
    Rollback(turnID string, epoch uint64) bool
    Register(turnID string) *mstream.InMemoryInterjectionBuffer
    Remove(turnID string)
}
```

The v1 adapter:
- `Route()` → `registry.GetOrCreate(turnID)` then `buffer.Append/Replace`
- `BeginDrain()` → `buffer.DrainAndClear()` (returns epoch=0, no real epoch fencing yet)
- `CompleteDrain()` → no-op (returns "", true)
- `Rollback()` → no-op (returns true)
- `Register()` → `registry.GetOrCreate(turnID)` (returns the buffer for backward compat)
- `Remove()` → `registry.Remove(turnID)`

## Files to Modify

| File | Change |
|------|--------|
| `backend/internal/service/llm/streaming/deps.go` | `ServiceDeps.InterjectionRegistry *mstream.InterjectionRegistry` → `InterjectionRouter InterjectionRouter` |
| `backend/internal/service/llm/streaming/stream_runtime.go:28` | `interjectionRegistry *mstream.InterjectionRegistry` → `interjectionRouter InterjectionRouter`; update `StreamRuntimeDeps` similarly |
| `backend/internal/service/llm/streaming/stream_runtime.go:152+` | In `Launch()`: replace `r.interjectionRegistry.GetOrCreate(turnID)` with `r.interjectionRouter.Register(turnID)` |
| `backend/internal/service/llm/streaming/stream_runtime.go:266-343` | **SwitchStream atomicity fix**: wrap `UpdateTurnStatus` + `persistSwitchTurns` in a single transaction with reversed order (create successor first, then complete old turn with `successor_turn_id` in response_metadata) |
| `backend/internal/service/llm/streaming/stream_executor.go:125-126` | Replace `interjectionBuffer mstream.InterjectionBuffer` + `streamRuntime *StreamRuntime` with `interjectionRouter InterjectionRouter` |
| `backend/internal/service/llm/streaming/tool_executor.go:210-272` | Replace `se.interjectionBuffer.DrainAndClear()` pattern with `se.interjectionRouter.BeginDrain()`/`CompleteDrain()`/`Rollback()`. See [interjection-forwarder.md](../design/interjection-forwarder.md) §Usage at Drain Points |
| `backend/internal/service/llm/streaming/completion_handler.go:98-165` | Same drain pattern replacement as tool_executor.go |
| `backend/internal/service/llm/streaming/interjection.go:23-37` | Service methods use `InterjectionRouter.Route()` instead of direct buffer access |
| `backend/internal/service/llm/streaming/stream_runtime.go` (cleanup section) | Executor cleanup callback: replace `interjectionRegistry.Remove(turnID)` with `interjectionRouter.Remove(turnID)` |

## SwitchStream Atomicity Fix (R10)

Current code at `stream_runtime.go:288-299`:
```go
// CURRENT: separate operations — failure window
err := r.executorDeps.TurnWriter.UpdateTurnStatus(ctx, input.CurrentTurnID, ...)
userTurn, assistantTurn, err := r.persistSwitchTurns(ctx, input)
```

Fixed version (inside a single transaction, reversed order):
```go
err := r.txManager.WithTx(ctx, func(txCtx context.Context) error {
    userTurn, assistantTurn, err = r.persistSwitchTurns(txCtx, input)
    if err != nil {
        return err
    }
    return r.executorDeps.TurnWriter.UpdateTurnStatus(txCtx, input.CurrentTurnID,
        domainllm.TurnStatusComplete, nil,
        map[string]any{"successor_turn_id": assistantTurn.ID},
    )
})
```

Note: `persistSwitchTurns` already uses `r.txManager.WithTx`. The fix wraps BOTH operations in a single outer transaction. Check whether the `TxManager` supports nested transactions or needs the inner `WithTx` removed.

## Patterns to Follow

- Existing interface patterns in `deps.go` (e.g., `ThreadValidator`, `LLMProviderGetter`)
- Adapter wrapping pattern: thin struct with concrete fields that delegates to existing types

## Verification Criteria

- [ ] `go build ./backend/...` passes
- [ ] `go test ./backend/internal/service/llm/streaming/...` passes
- [ ] Interjection at tool boundary still triggers stream switch (manual or integration test)
- [ ] Interjection at no-tools completion still triggers stream switch
- [ ] SwitchStream creates successor BEFORE completing old turn (verify transaction order)
- [ ] `go vet ./backend/...` passes

## Agent Staffing

- **Implementer**: `coder` (default codex — clear blueprint, reviewers catch issues)
- **Reviewers**: 1x correctness review (opus — focus: SwitchStream transaction ordering, drain pattern equivalence), 1x SOLID review (gpt-5.4 — focus: interface shape, adapter doesn't leak abstractions)
- **Verification**: `verifier`
