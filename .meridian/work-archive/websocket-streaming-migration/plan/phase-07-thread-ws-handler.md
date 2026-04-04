# Phase 7: Thread WS Handler + Service Integration

## Scope

Build the thread WS handler — the core of the migration. This handler manages turn streaming, spawn discovery, interjection routing, and turn lifecycle notifications for an entire project through a single WS connection.

Includes:
1. `TurnStreamHandler` implementing `wsutil.Handler` with full subscribe/unsubscribe/message/disconnect lifecycle
2. `ActiveTurnHandle` + `ActiveTurnRegistry` interfaces (R5 — introduced with first consumer)
3. Live-event goroutine management (mstream channel → `SendToSub`)
4. Interjection via `stream.message` → `InterjectionRouter.Route()`
5. Service-layer notify event emission through `wsutil.Broadcaster`
6. Route registration

This is the largest and most architecturally complex phase.

## What's Out of Scope

- Frontend ThreadWsProvider (Phase 9)
- SSE handler removal (Phase 10)
- Byte-budget backpressure (deferred)
- Yjs CRDT sync via doc WS stream lane (deferred)

## Prerequisites

- **Phase 2** (InterjectionForwarder + transport-neutral service layer — handler uses `InterjectionRouter.Route()`, `SwitchResult` has no `StreamURL`)
- **Phase 4** (mstream fixes — handler uses `SubscribeWithCatchup()` for atomic catchup+live)
- **Phase 5** (wsutil framework — handler implements `wsutil.Handler`)
- **Phase 6** (Doc WS handler — soft dependency; validates the framework. Thread WS CAN start without this if Phase 6 runs long, but ideally Phase 6 completes first.)

## Files to Create

### `backend/internal/handler/thread_ws_handler.go`

```go
type TurnStreamHandler struct {
    streamRegistry     *mstream.Registry
    interjectionRouter InterjectionRouter
    activeTurnRegistry ActiveTurnRegistry
    turnStreamStarter  TurnStreamStarter
    authorizer         authdomain.ResourceAuthorizer
    projectBroadcaster wsutil.Broadcaster
    logger             *slog.Logger
}

// Per-connection state
type turnStreamState struct {
    session   wsutil.Session
    liveFeeds map[string]*liveFeed  // subId → mstream live feed
    mu        sync.Mutex
}

type liveFeed struct {
    turnId   string
    liveChan <-chan mstream.Event
    cancel   context.CancelFunc
}
```

### `backend/internal/service/llm/streaming/active_turn.go`

```go
// ActiveTurnHandle abstracts StreamExecutor for external consumers.
type ActiveTurnHandle interface {
    RequestSoftCancel()
    RequestHardCancel()
    State() ExecutorState
    ThreadID() string
    TurnID() string
}

// ActiveTurnRegistry replaces concrete ExecutorRegistry for external consumers.
type ActiveTurnRegistry interface {
    GetByTurn(turnID string) (ActiveTurnHandle, bool)
    GetByThread(threadID string) (ActiveTurnHandle, bool)
}
```

`ExecutorRegistry` implements `ActiveTurnRegistry`. `StreamExecutor` implements `ActiveTurnHandle` (it already has these methods).

### `backend/internal/service/llm/streaming/turn_stream_starter.go`

```go
// TurnStreamStarter abstracts Launch/SwitchStream for the WS handler.
type TurnStreamStarter interface {
    Launch(ctx context.Context, input *LaunchInput) error
    SwitchStream(ctx context.Context, input *SwitchStreamInput) (*SwitchResult, error)
}
```

`StreamRuntime` implements this interface (it already has these methods).

## Files to Modify

| File | Change |
|------|--------|
| `backend/internal/service/llm/streaming/deps.go:20-64` | `ExecutorRegistry` gains `GetByTurn(turnID) (ActiveTurnHandle, bool)` and `GetByThread(threadID) (ActiveTurnHandle, bool)` methods implementing `ActiveTurnRegistry` |
| `backend/internal/service/llm/streaming/stream_executor.go` | Add `TurnID() string` method if missing (already has `ThreadID()`) |
| `backend/internal/service/llm/streaming/stream_executor.go` | Emit notify events on terminal states: modify `Terminate()` or cleanup callback to call `broadcaster.BroadcastNotify()` for `completed`, `error`, `cancelled` events |
| `backend/internal/service/llm/streaming/spawn_service.go` | Emit `spawn_started` notify event when a spawn launches |
| `backend/internal/service/llm/streaming/launch_stream.go` | Emit `stream_started` notify event when a turn starts streaming |
| `backend/internal/service/llm/streaming/deps.go` | Add `Broadcaster wsutil.Broadcaster` to `InfraDeps` (optional — nil for tests) |
| `backend/internal/app/domains/llm.go` | Add thread WS route: `mux.HandleFunc("GET /ws/projects/{projectId}/threads", threadServer.Serve)`. Wire server with wsutil.NewServer + TurnStreamHandler. |

## OnSubscribe — The Complex Operation

This is the most complex handler method. See [thread-ws.md](../design/thread-ws.md) §OnSubscribe for the full algorithm:

```
1. Framework has already validated subscription limit (10/connection)
2. If already subscribed to this turnId with a different subId, unsubscribe the old one
3. Validate turn auth (CanAccessTurn)
4. Look up stream in mstream.Registry
5. If stream not found:
   a. Check turn status via DB
   b. If terminal → send subscribed + immediate ended
   c. If pending → send subscribed (client waits for notify)
   d. If streaming but not in registry → send gap
6. If stream found:
   a. Call stream.SubscribeWithCatchup(subId, lastSeq, epoch)
   b. If epoch mismatch → send gap
   c. If stream terminal → send subscribed + catchup + ended
   d. Otherwise → send subscribed + catchup, start live-event goroutine
```

The live-event goroutine:
- Reads from `liveChan` (returned by `SubscribeWithCatchup`)
- Calls `session.SendToSub(subId, envelope)` for each event (wraps mstream Event in protocol Envelope with seq/epoch)
- When channel closes → send `ended` message with appropriate reason
- Deferred `recover()` → on panic: log, call `session.EndSub(subId)`, remove mstream client

## OnMessage — Interjection

Validates using the same DTO/validator as the HTTP interjection endpoint. Routes through `InterjectionRouter.Route()`. Sends result back via control lane (`interjection_result` op). See [thread-ws.md](../design/thread-ws.md) §OnMessage.

## Notify Events

Service layer emits these through `Broadcaster.BroadcastNotify()`:

| Event | Emitted by | Resource |
|-------|-----------|----------|
| `spawn_started` | `spawn_service.go` | parent turn |
| `completed` | `stream_executor.go` cleanup | turn |
| `error` | `stream_executor.go` cleanup | turn |
| `cancelled` | `stream_executor.go` cleanup | turn |
| `stream_started` | `launch_stream.go` | turn |

## Patterns to Follow

- Doc WS handler (Phase 6) for framework integration and authenticator wiring
- Existing `sse_handler.go` for how streaming currently bridges mstream → transport
- Existing `interjection.go` for interjection validation logic (reuse DTO/validator)

## Verification Criteria

- [ ] `go build ./backend/...` passes
- [ ] New endpoint reachable: `GET /ws/projects/{projectId}/threads` accepts WS upgrade
- [ ] Auth flow works (same pattern as doc WS)
- [ ] Subscribe to active turn → receive `subscribed` + catchup + live events
- [ ] Subscribe to completed turn → receive `subscribed` + catchup + `ended`
- [ ] Subscribe to non-existent turn in registry but streaming in DB → receive `gap`
- [ ] Subscribe to pending turn → receive `subscribed` (no events until stream starts)
- [ ] Interjection via WS → routed to InterjectionRouter → result returned via control lane
- [ ] Spawn notification: spawn launches → all project connections receive `spawn_started` notify
- [ ] Turn completion: turn finishes → all project connections receive `completed` notify
- [ ] Stream switch: interjection at tool boundary → `ended{reason: stream_switch}` with `newAssistantTurnId`
- [ ] Disconnect cleanup: all live goroutines cancelled, mstream clients removed
- [ ] `go test ./backend/internal/handler/...` passes
- [ ] `go test ./backend/internal/service/llm/streaming/...` passes
- [ ] `go vet ./backend/...` passes

## Agent Staffing

- **Implementer**: `coder` (default codex — blueprint covers all cases, 3 reviewers verify)
- **Reviewers**: 1x concurrency review (gpt-5.4 — focus: live-event goroutine lifecycle, panic recovery, cleanup ordering), 1x correctness review (opus — focus: OnSubscribe state machine covering all cases from design doc), 1x security review (gpt-5.4 — focus: per-subscribe auth check, interjection validation parity with HTTP path)
- **Testing**: `unit-tester` (OnSubscribe edge cases), `smoke-tester` (end-to-end: create turn → subscribe via WS → see events → send interjection)
- **Verification**: `verifier`
