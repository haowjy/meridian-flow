# Phase 2: Service Layer Hardening + InterjectionForwarder

## Scope

Four coordinated changes that make the streaming service layer transport-neutral and fix the interjection drain race:

1. **InterjectionForwarder** — Replace the Phase 1 adapter with the real epoch-fenced forwarder (design: [interjection-forwarder.md](../design/interjection-forwarder.md))
2. **StreamURL removal** (R6) — Remove `StreamURL` from service layer, making `SwitchResult` transport-neutral
3. **StreamExecutor config struct** (R9) — Replace 22+ positional constructor args with a config struct
4. **Noise cleanup** (R7) — Remove `StateSize` TODO and unused `capRegistry` field

These are combined because they all touch the same ~6 files in `streaming/` and must be sequenced after Phase 1. Merging them into one phase avoids a third sequential round on the critical path.

## What's Out of Scope

- wsutil framework or WS handler code
- Frontend changes (frontend will stop receiving `StreamURL` but the HTTP handler constructs it; no frontend change needed)
- mstream library fixes (Phase 4)

## Prerequisites

- **Phase 1** (InterjectionRouter interface exists; all call sites use it; SwitchStream is atomic)

## Files to Create

- `backend/internal/service/llm/streaming/interjection_forwarder.go` — Full `InterjectionForwarder` struct implementing `InterjectionRouter`

State machine per turn: `idle` → `draining` → `forwarded`. Epoch-fenced transitions. See [interjection-forwarder.md](../design/interjection-forwarder.md) §State Machine and §Data Structure for the complete spec.

Key implementation details:
- `sync.Map` for top-level entry lookup (turn ID → `*turnEntry`)
- Per-entry `sync.Mutex` for phase transitions
- `Route()` follows forwarding chain internally (max 10 hops, no caller loop)
- `pending` buffer captures interjections during drain window

## Files to Modify

| File | Change |
|------|--------|
| `backend/internal/service/llm/streaming/interjection_router.go` | Remove the v1 adapter (replaced by InterjectionForwarder). Keep the interface definition. |
| `backend/internal/service/llm/streaming/stream_runtime.go:97-102` | `StreamSwitchResult`: remove `StreamURL string`, type `UserTurn` and `AssistantTurn` as `*domainllm.Turn` instead of `any` |
| `backend/internal/service/llm/streaming/stream_runtime.go:127-227` | `Launch()`: remove `streamURL := fmt.Sprintf(...)` line; update return to exclude StreamURL |
| `backend/internal/service/llm/streaming/stream_runtime.go:266-343` | `SwitchStream()`: remove `StreamURL` from return value |
| `backend/internal/service/llm/streaming/tool_executor.go:254-268` | Remove `result.StreamURL` from `EmitStreamSwitch` and logging. Update drain pattern to use forwarder's `CompleteDrain` + late interjection forwarding (per design doc §Usage at Drain Points). |
| `backend/internal/service/llm/streaming/completion_handler.go:146-165` | Same: remove `result.StreamURL`, update drain pattern |
| `backend/internal/service/llm/streaming/interjection.go:104` | Remove `StreamURL` from `UpsertInterjectionResponse` usage |
| `backend/internal/service/llm/streaming/agui/events.go:148,165` | Remove `StreamURL` field from `StreamSwitchEvent`; `EmitStreamSwitch` drops the streamURL parameter |
| `backend/internal/domain/llm/streaming_service.go` | Remove `StreamURL` from `CreateTurnResponse` and `UpsertInterjectionResponse` |
| `backend/internal/handler/thread.go` | Where `StreamURL` was returned to frontend: construct URL at handler layer: `fmt.Sprintf("/api/turns/%s/stream", turnID)` |
| `backend/internal/service/llm/streaming/stream_executor.go` | Replace 22+ positional constructor `NewStreamExecutor(...)` with `NewStreamExecutor(cfg StreamExecutorConfig)`. Config struct groups: identity fields, deps, runtime config, interjection router. |
| `backend/internal/service/llm/streaming/stream_runtime.go:154-178` | `Launch()`: build `StreamExecutorConfig` struct and pass it |
| `backend/internal/service/llm/streaming/token_monitor.go:62,67,70` | Remove unused `capRegistry` field from `TokenMonitor` struct and constructor |
| `backend/internal/handler/collab_document_handler.go:239-243` | Remove hardcoded `StateSize: 0` with its TODO comment |
| DI wiring | Update any dependency injection that passes `InterjectionRegistry` to pass the `InterjectionForwarder` instead |

## InterjectionForwarder: Key Drain Point Pattern

After this phase, both drain points (tool_executor.go and completion_handler.go) use:

```go
epoch, drained, ok := se.interjectionRouter.BeginDrain(se.turnID)
if !ok { continue }
if drained == "" {
    se.interjectionRouter.Rollback(se.turnID, epoch)
    continue
}
result, err := se.streamRuntime.SwitchStream(ctx, &SwitchStreamInput{...})
if err != nil {
    se.interjectionRouter.Rollback(se.turnID, epoch)
    return err
}
// CRITICAL: successor is already registered by Launch() before CompleteDrain
late, _ := se.interjectionRouter.CompleteDrain(se.turnID, epoch, result.AssistantTurn.ID)
if late != "" {
    if _, _, err := se.interjectionRouter.Route(result.AssistantTurn.ID, late, "append"); err != nil {
        se.logger.Warn("failed to forward late interjection", ...)
    }
}
```

## Patterns to Follow

- Existing `StreamRuntimeDeps` struct pattern for the `StreamExecutorConfig` struct
- `sync.Map` usage in `ExecutorRegistry` (deps.go:21) for the forwarder's entry map

## Verification Criteria

- [ ] `go build ./backend/...` passes
- [ ] `go test ./backend/internal/service/llm/streaming/...` passes — all existing tests pass with forwarder replacing adapter
- [ ] New unit tests for `InterjectionForwarder`:
  - `Route()` in idle phase → writes to buffer
  - `Route()` in draining phase → writes to pending, returns `held=true`
  - `Route()` in forwarded phase → follows chain, delivers to successor
  - `BeginDrain()` + `CompleteDrain()` flow captures late interjections
  - `BeginDrain()` + `Rollback()` merges pending back to active
  - Epoch fencing: stale `CompleteDrain` rejected
  - Forwarding chain: 10-hop limit enforced
- [ ] No `StreamURL` references remain in `backend/internal/service/` (grep verification)
- [ ] `go vet ./backend/...` passes

## Agent Staffing

- **Implementer**: `coder` (default codex — blueprint is detailed, unit-tester + reviewers verify correctness)
- **Reviewers**: 1x concurrency review (gpt-5.4 — focus: InterjectionForwarder lock ordering, epoch fencing correctness, forwarding chain safety), 1x SOLID/design alignment review (opus — focus: interface conformance with [interjection-forwarder.md](../design/interjection-forwarder.md))
- **Testing**: `unit-tester` for InterjectionForwarder (state machine edge cases are subtle)
- **Verification**: `verifier`
