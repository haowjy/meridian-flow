# Thread WS — Streaming Connection

The thread WS handles turn streaming and spawn management for a project. It instantiates the [generic protocol](protocol.md) via the [wsutil framework](framework.md) with handlers for turn resources.

**Endpoint**: `GET /ws/projects/{projectId}/threads`

Related: [interjection-forwarder.md](interjection-forwarder.md) for the drain race fix, [frontend.md](frontend.md) for client-side integration.

## Handler Registration

```go
threadServer := wsutil.NewServer(
    wsutil.WithAuth(authenticator),
    wsutil.WithHeartbeat(20*time.Second, 20*time.Second),
    wsutil.WithRateLimit(30),
    wsutil.WithOriginPatterns(allowedOrigins...),
    wsutil.WithReadLimit(64 * 1024),
)
threadServer.RegisterHandler("turn", turnStreamHandler)
mux.HandleFunc("GET /ws/projects/{projectId}/threads", threadServer.Serve)
```

The handler registers for resource type `"turn"`. Subscribe/unsubscribe target individual turns. Notify events cover turns, threads, and spawns within the project.

## Turn Stream Handler

Implements `wsutil.Handler`. Manages per-connection subscription state and bridges between the wsutil framework and mstream library.

```go
type TurnStreamHandler struct {
    streamRegistry    *mstream.Registry
    interjectionRouter InterjectionRouter
    activeTurnRegistry ActiveTurnRegistry
    turnStreamStarter  TurnStreamStarter
    authorizer         authdomain.ResourceAuthorizer
    projectBroadcaster wsutil.Broadcaster  // for project-wide notify events
    logger             *slog.Logger
}

// Per-connection state. Note: the framework tracks subId→resource mapping and
// enforces limits. The handler only tracks mstream-specific state (live channels,
// goroutine cancellation). Subscription IDs are NOT duplicated here.
type turnStreamState struct {
    session      wsutil.Session
    liveFeeds    map[string]*liveFeed  // subId → mstream live feed (goroutine + channel)
    mu           sync.Mutex
}

type liveFeed struct {
    turnId   string
    liveChan <-chan mstream.Event
    cancel   context.CancelFunc  // stops the goroutine reading liveChan
}
```

### OnConnect

Creates per-connection state. No subscriptions yet.

### OnSubscribe

This is the most complex operation. It must atomically resolve catchup events and register for live delivery. Note: the **framework** enforces the 10-subscription limit and tracks active subIds. The handler does NOT maintain its own subscription map — it manages mstream client registration and live-event goroutines only.

```
1. Framework has already validated subscription limit (10/connection)
2. If already subscribed to this turnId with a different subId, unsubscribe the old one
3. Validate turn auth (CanAccessTurn)
4. Look up stream in mstream.Registry
5. If stream not found:
   a. Check turn status via DB
   b. If terminal → send subscribed + immediate ended (including stop_reason and successor info if stream_switch)
   c. If pending → send subscribed (client waits for notify)
   d. If streaming but not in registry → send gap (server lost in-memory stream, e.g., restart)
      Client will fall back to REST. If REST also says streaming and client re-subscribes,
      this will gap again → client should stop after two consecutive gaps (see protocol.md).
6. If stream found:
   a. Call stream.SubscribeWithCatchup(subId, lastSeq, epoch)
   b. If epoch mismatch or lastSeq too old → send gap
   c. If stream terminal → send subscribed + catchup events + ended
   d. Otherwise → send subscribed + catchup events, start goroutine for live events
```

The live-event goroutine reads from the mstream channel and calls `session.SendToSub(subId, ...)` for each event. When the channel closes (stream completed), it sends an `ended` message.

The goroutine body MUST be wrapped in deferred `recover()`. On panic: log with stack trace, call `session.EndSub(subId)`, remove the mstream client, and return. The connection stays alive.

### OnUnsubscribe

Cancels the live-event goroutine, removes the mstream client, cleans up state.

### OnMessage (Interjection)

Client sends interjection via the stream lane:

```json
{
  "kind": "stream",
  "op": "message",
  "resource": { "type": "turn", "id": "T1" },
  "payload": {
    "action": "interjection",
    "text": "Actually, try a different approach",
    "mode": "append|replace"
  }
}
```

Handler:
1. Validates using the same DTO/validator as the HTTP interjection endpoint (UUID format, non-empty trimmed content, valid mode enum, reject unknown fields)
2. Re-checks turn auth (`CanAccessTurn`)
3. Routes through `InterjectionRouter.Route()` (same service-layer path as HTTP)
4. Sends result back via control lane:

```json
{
  "kind": "control",
  "op": "interjection_result",
  "resource": { "type": "turn", "id": "T1" },
  "payload": {
    "mode": "queued|created",
    "content": "string (queued only)",
    "newAssistantTurnId": "uuid (created only)"
  }
}
```

`queued`: interjection buffered while turn is streaming. `created`: follow-up turns created because turn was not streaming — includes new assistant turn ID so client can subscribe.

### OnDisconnect

Cancels all live-event goroutines. Removes all mstream clients. Cleans up state.

## Notify Events

The thread WS emits notify events for all project-scoped thread/turn activity. These are broadcast to all connections for the project via the framework's notify mechanism.

| Event | Resource | Payload | When |
|---|---|---|---|
| `spawn_started` | `turn` (parent) | `{ "event": "spawn_started", "spawnThreadId": "...", "spawnTurnId": "..." }` | Spawn launched |
| `completed` | `turn` | `{ "event": "completed", "version": N }` | Turn finished successfully |
| `error` | `turn` | `{ "event": "error" }` | Turn errored |
| `cancelled` | `turn` | `{ "event": "cancelled" }` | Turn cancelled |
| `stream_started` | `turn` | `{ "event": "stream_started" }` | Turn started streaming |

### Spawn Discovery

When a spawn launches, the service layer emits a `spawn_started` notify event to all connections for the project. The frontend uses this to:
1. Invalidate relevant TanStack Query keys (thread list, spawn list)
2. Optionally auto-subscribe to the spawn's assistant turn for streaming

This replaces the previous design's `spawn_started` channel message. In the generic protocol, spawn discovery is a notify event — the frontend decides whether to subscribe.

## Stream Switch

When a stream switch occurs (interjection at tool boundary or completion):

1. The current turn's stream sends `ended` with `reason: "stream_switch"` and `newAssistantTurnId` in the payload
2. A `stream_started` notify event is broadcast for the new assistant turn
3. The frontend auto-subscribes to the new turn

This replaces the SSE `STREAM_SWITCH` event entirely. The `ended` message is the canonical stream-switch signal.

## Successor Stream Retention

When a stream switch creates a successor turn, the successor's mstream buffer is retained until first subscribe (or a TTL of 30s). This prevents the race where a fast successor completes before the client subscribes and the buffer is purged.

## Service Layer Interfaces

These explicit interfaces replace concrete dependencies, making the streaming service transport-neutral:

```go
// ActiveTurnHandle abstracts StreamExecutor for external consumers.
type ActiveTurnHandle interface {
    RequestSoftCancel()
    RequestHardCancel()
    State() ExecutorState
    ThreadID() string
    TurnID() string
}

// ActiveTurnRegistry replaces concrete ExecutorRegistry.
type ActiveTurnRegistry interface {
    GetByTurn(turnID string) (ActiveTurnHandle, bool)
    GetByThread(threadID string) (ActiveTurnHandle, bool)
}

// InterjectionRouter abstracts interjection routing (forwarder + buffer).
// See interjection-forwarder.md for the full design.
type InterjectionRouter interface {
    Route(turnID, content, mode string) (targetTurnID string, held bool, err error)
    BeginDrain(turnID string) (epoch uint64, drained string, ok bool)
    CompleteDrain(turnID string, epoch uint64, newTurnID string) (late string, ok bool)
    Rollback(turnID string, epoch uint64) bool
}

// TurnStreamStarter abstracts Launch/SwitchStream.
// Returns transport-neutral data — turn IDs and resume metadata, not URLs.
type TurnStreamStarter interface {
    Launch(ctx context.Context, input *LaunchInput) error
    SwitchStream(ctx context.Context, input *SwitchStreamInput) (*SwitchResult, error)
}

// SwitchResult is transport-neutral.
type SwitchResult struct {
    UserTurn      *Turn
    AssistantTurn *Turn
    // No StreamURL — transport layer discovers streams via Registry
}
```

## mstream Library Fixes Required

These bugs in `meridian-stream-go/` must be fixed before WS replay works:

| Issue | Current Behavior | Fix |
|---|---|---|
| C1: Buffer clears on completion | `markCompleted()` calls `ClearBuffer()` immediately. Terminal events lost on reconnect. | Delay buffer clear (grace period). |
| C1: `GetSince` ambiguity | Returns nil for both "not found" and "no events after". | Return `(events []Event, found bool)`. |
| H2: Subscribe before catchup | `AddClient()` and `GetCatchupEvents()` are separate calls — race for duplicates. | Atomic `SubscribeWithCatchup(clientID, lastSeq, epoch) → (catchup, liveChan, status, err)`. |
| H3: `AddClient` on terminal stream | Blocks forever (channel never closed). | Return error or immediately-closed channel. |
| H1: Event IDs debug-only | Gated behind `enableEventIDs` flag. | Always-on event IDs (mandatory for seq tracking). |
| H6: Registry overwrites hooks | `Register()` overwrites caller-set `onComplete`/`onError`. | Compose hooks instead of overwriting. |
| H7: Catchup errors discarded | `GetCatchupEvents()` silently ignores `catchupFunc` errors. | Propagate errors to caller. |

## Authorization

| Operation | Auth Check |
|---|---|
| Connect | JWT + `CanAccessProject` |
| Heartbeat | JWT expiry + `CanAccessProject` (re-check) |
| Subscribe | `CanAccessTurn` per subscribe |
| Interjection | `CanAccessTurn` per message |

Re-auth on heartbeat tears down ALL subscriptions if the user loses project access.

## Key Files (current codebase)

| Area | File |
|---|---|
| SSE handler (to be replaced) | `backend/internal/handler/sse_handler.go` |
| mstream library | `meridian-stream-go/stream.go`, `registry.go`, `buffer.go` |
| Executor registry | `backend/internal/service/llm/streaming/deps.go` |
| Stream runtime | `backend/internal/service/llm/streaming/stream_runtime.go` |
| AG-UI emitter | `backend/internal/service/llm/streaming/agui/emitter.go` |
| Route registration | `backend/internal/app/domains/llm.go` |
