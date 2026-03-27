# Streaming Cancellation Model

Cancellation is capability-based per model/provider. `InterruptTurn` chooses hard or soft cancellation using `supports_streaming_cancel` and then delegates to executor control commands.

Refs: `backend/internal/service/llm/streaming/interruption.go:12`, `backend/internal/service/llm/streaming/interruption.go:75`, `backend/internal/service/llm/streaming/cancel_handler.go:14`

## Hard vs Soft Cancel

| Mode | Selected when | User-visible behavior | Provider behavior |
|---|---|---|---|
| Hard cancel | `supports_streaming_cancel=true` (e.g., Anthropic) | Stream ends immediately | Provider stream is actively cancelled |
| Soft cancel | `supports_streaming_cancel=false` or unknown | Client disconnects immediately | Executor keeps draining provider metadata in background |

Refs: `backend/internal/service/llm/streaming/interruption.go:57`, `backend/internal/service/llm/streaming/interruption.go:76`, `backend/internal/service/llm/streaming/interruption.go:85`

## PersistenceGuard (Cancel-vs-Persist Race Guard)

```
Without guard:                    With guard:
1. Cancel queued                  1. Disarm() -- atomic store
2. Streaming goroutine in         2. Cancel queued
   PersistAndClear callback       3. PersistAndClear checks
3. State check passes               IsArmed() -- atomic load
   (command not processed yet)    4. Returns false, skip persist
4. Block persisted despite cancel
```

`RequestSoftCancel` / `RequestHardCancel` disarm the guard before queueing control commands, so persistence callbacks observe cancel intent immediately across goroutines.

Refs: `backend/internal/service/llm/streaming/persistence_guard.go:7`, `backend/internal/service/llm/streaming/cancel_handler.go:22`, `backend/internal/service/llm/streaming/block_processor.go:203`

## Soft Cancel Flow

1. `InterruptTurn` chooses soft cancel and marks turn `cancelled`.
2. `RequestSoftCancel()` disarms persistence guard, queues `CmdSoftCancel`.
3. Streaming goroutine transitions `Streaming -> DrainMetadata`.
4. `handleSoftCancel` snapshots accumulated text, persists partial text/thinking blocks, emits AG-UI `RUN_ERROR(isCancelled=true)`, and calls `stream.SoftCancel()` to disconnect clients.
5. Provider stream continues in background.
6. Drain timer starts (`softCancelTimeout`); metadata completion path persists final token metadata and transitions to `Completed`.

Refs: `backend/internal/service/llm/streaming/interruption.go:91`, `backend/internal/service/llm/streaming/cancel_handler.go:21`, `backend/internal/service/llm/streaming/stream_executor.go:399`, `backend/internal/service/llm/streaming/cancel_handler.go:154`, `backend/internal/service/llm/streaming/stream_executor.go:404`, `backend/internal/service/llm/streaming/completion_handler.go:93`

## Hard Cancel Flow

1. `InterruptTurn` chooses hard cancel and marks turn `cancelled`.
2. `RequestHardCancel()` disarms persistence guard, queues `CmdHardCancel`.
3. Streaming goroutine transitions to `HardCancelled`.
4. If provider supports generation cancel API, executor issues best-effort upstream cancel using captured generation ID.
5. Executor calls `handleError` for terminal cleanup and error/cancel finalization.
6. Service also calls `stream.Cancel()` to terminate active stream connection.

Refs: `backend/internal/service/llm/streaming/interruption.go:82`, `backend/internal/service/llm/streaming/cancel_handler.go:39`, `backend/internal/service/llm/streaming/stream_executor.go:415`, `backend/internal/service/llm/streaming/stream_executor.go:423`, `backend/internal/service/llm/streaming/stream_executor.go:454`, `backend/internal/service/llm/streaming/interruption.go:83`

## Soft-Cancel Timeout Cleanup

If drain timeout fires before metadata arrives:

1. Executor transitions `DrainMetadata -> TimedOut`.
2. Cancels provider stream (`stream.Cancel()`).
3. Finalizes best-effort tokens from cancel snapshot.
4. Runs settlement fallback for deferred mode when needed.
5. Emits `RUN_ERROR(isCancelled=true)`, transitions to `Errored`, runs cleanup callback.

Refs: `backend/internal/service/llm/streaming/cancel_handler.go:67`, `backend/internal/service/llm/streaming/cancel_handler.go:71`, `backend/internal/service/llm/streaming/cancel_handler.go:87`, `backend/internal/service/llm/streaming/cancel_handler.go:117`, `backend/internal/service/llm/streaming/cancel_handler.go:130`

## Cleanup Context Policy

Cleanup paths use `context.Background()` plus a bounded DB write deadline (`30s`) so persistence/finalization still runs after request context cancellation.

Refs: `backend/internal/service/llm/streaming/stream_executor.go:20`, `backend/internal/service/llm/streaming/completion_handler.go:215`, `backend/internal/service/llm/streaming/cancel_handler.go:81`
