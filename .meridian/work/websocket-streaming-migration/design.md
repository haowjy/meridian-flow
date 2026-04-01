# WebSocket Streaming Migration — Design

## Problem

Each streaming turn opens a separate SSE connection (`GET /api/turns/{id}/stream`). With parent + spawned agents, a single conversation can use 4-5 SSE connections, competing with API calls for the browser's ~6 HTTP/1.1 connection limit. Secondary: an interjection drain race silently loses user input between `DrainAndClear()` and executor cleanup.

**Goal**: Unified WS framework with multiplexed streaming on the per-project WebSocket. Fix the interjection drain race. Reduce entropy by consolidating WS infrastructure.

---

## Architecture

### Unified WS Framework with Pluggable Channel Handlers

Build a generic WS framework (`backend/internal/wsutil/`). Collab and streaming register as pluggable channel handlers on one endpoint.

```go
ws := wsutil.NewProjectServer(
  wsutil.WithAuth(authenticator),
  wsutil.WithHeartbeat(20*time.Second),
  wsutil.WithRateLimit(30),
  wsutil.WithOriginPatterns(allowedOrigins),
  wsutil.WithReadLimit(64 * 1024),
)
ws.Register("collab", collabHandler)
ws.Register("streaming", streamHandler)
mux.HandleFunc("GET /ws/projects/{projectId}", ws.Serve)
```

**Endpoint**: `GET /ws/projects/{projectId}` (rebuilt internals on `coder/websocket`)

### Why multiplexing

Spawns create separate threads. Parent + 3 spawns + grandchild = 5 threads streaming simultaneously. Per-thread WS means 5 independent connections with 5 auth handshakes, 5 heartbeats, 5 reconnection state machines. Multiplexed: one connection, server pushes `spawn_started` as children launch, frontend sends `subscribe`, events flow. Child thread/spawn lifecycle management stays server-side where the spawn tree is already known.

Note: WebSocket connections are NOT subject to the HTTP/1.1 ~6 connection limit. Multiplexing is justified by spawn management simplicity, not connection starvation.

### Why a unified framework

- Collab and streaming share identical infrastructure: auth, heartbeat, rate limiting, write serialization, message dispatch
- Separate endpoints means duplicated code that drifts over time (entropy)
- Framework extraction is a one-time cost; every future real-time feature is a handler registration
- OCP-compliant: new features (presence, notifications) register a handler, don't modify framework
- Project is the natural authorization boundary (all threads/turns belong to a project)

### Connections per user

- 1 project WS (collab + streaming) per active project
- N document WS (Yjs sync per open doc) — stays separate (binary CRDT frames)

---

## WS Framework Design

### ChannelHandler Interface

Channels don't get raw connection access. The framework provides a `ChannelSession` abstraction for outbound communication, so the framework retains control over scheduling, backpressure, and write serialization.

```go
// ChannelHandler is implemented by each channel (collab, streaming, etc.)
type ChannelHandler interface {
    // OnConnect is called when a new authenticated connection is established.
    // Returns a ChannelState that the framework associates with this connection.
    OnConnect(session ChannelSession) (ChannelState, error)

    // OnMessage handles an inbound message routed to this channel.
    OnMessage(state ChannelState, msg json.RawMessage) error

    // OnDisconnect is called when the connection closes. Clean up channel state.
    OnDisconnect(state ChannelState)
}

// ChannelSession is the framework-owned egress API given to handlers.
// Handlers write messages through this; framework manages scheduling and serialization.
type ChannelSession interface {
    // Send queues a message for delivery to this connection.
    // The framework manages per-channel queues, fair scheduling, and backpressure.
    Send(msg any) error

    // UserID returns the authenticated user.
    UserID() string

    // ProjectID returns the project this connection is scoped to.
    ProjectID() string

    // ConnectionID returns a unique identifier for this connection.
    ConnectionID() string
}

// ChannelState is opaque per-channel state held by the framework.
// The streaming channel stores subscription maps here; collab stores sync state.
type ChannelState interface{}
```

**Why this shape**:
- Handlers never hold raw connection handles → framework controls all writes (SRP)
- Per-channel send queues with fair scheduling → no hot-stream starvation (RC2)
- Framework wraps `OnMessage` in `recover()` → channel panic doesn't kill the connection (RH12)
- Channels can emit server-initiated events (spawn_started, ended) via `session.Send()` at any time

### Framework Responsibilities

| Concern | Owner |
|---------|-------|
| WS upgrade, TLS | Framework (`coder/websocket`) |
| Origin enforcement | Framework |
| Pre-auth semaphore + per-IP throttle | Framework |
| JWT-first-message auth + project membership | Framework |
| Heartbeat (ping/pong) + JWT expiry + project re-auth | Framework |
| Inbound rate limiting (30 msg/s) | Framework |
| Message routing by `channel` field | Framework |
| Per-channel outbound queues + fair scheduling | Framework |
| Write serialization (one writer at a time) | Framework |
| Connection registry (per-project, per-user tracking) | Framework |
| Panic recovery per channel handler | Framework |
| Channel-specific message types and business logic | Channel handler |
| Channel-specific state (subscriptions, sync state) | Channel handler |

### ProjectServer Components

Split into focused components (not one god-struct):

- `server.go` — `ProjectServer` with options pattern, upgrade, lifecycle orchestration
- `conn.go` — `Connection` wrapper: write-safe, holds channel sessions, panic boundaries
- `auth.go` — JWT bootstrap, project membership verification, re-auth on heartbeat
- `heartbeat.go` — ping/pong loop, JWT expiry check, project membership re-check
- `router.go` — parse `{"channel", "type"}`, dispatch to handler, reject unknown channels
- `scheduler.go` — per-channel outbound queues, fair round-robin, byte-budget enforcement
- `ratelimit.go` — inbound rate tracker
- `registry.go` — per-project connection tracking, per-user connection limits

---

## Protocol Specification

### Framework-Level Messages

All messages require a `channel` field except framework-level messages (`pong`). Messages without `channel` are rejected.

**Auth**: JWT-first-message bootstrap with 5-second timeout, project membership via `bootstrapProjectAuth()`.

**Heartbeat**: Framework sends `ping`, expects `pong`. 20s interval, 20s timeout. On each heartbeat, framework re-checks JWT expiry AND project membership. Failure → tear down all channel states, close connection.

**Rate Limiting**: 30 msg/s per connection.

**Message Routing**: Framework parses `{"channel": "...", "type": "..."}`, dispatches to registered handler. Messages with unknown or missing `channel` are rejected with an error frame and logged. Framework-level messages (`pong`) have no channel field.

**Connection Lifecycle**:
1. Client opens WS to `/ws/projects/{projectId}`
2. Server validates origin, enforces pre-auth semaphore
3. Client sends JWT (5s deadline)
4. Server verifies project membership, sends `{ "type": "connected", "channels": ["collab", "streaming"] }`
5. Server starts heartbeat (20s interval, re-checks project membership)
6. Client sends channel-routed messages; framework dispatches to handlers
7. On disconnect: framework calls `OnDisconnect` on all channel handlers

**Framework Limits**:

| Concern | Limit | Mechanism |
|---------|-------|-----------|
| Max connections/user/project | 5 | Server counter, reject upgrade with 429 |
| Inbound rate limit | 30 msg/s | Framework-level rate tracker |
| Pre-auth connections | Global semaphore (size 100) | Per-IP(/64) throttle |
| Frame size | 64KB | `ReadLimit` on accept |

### Streaming Channel Messages

**Client → Server**:

```json
{ "channel": "streaming", "type": "subscribe", "turnId": "uuid", "lastSeq": 42, "epoch": "string" }
{ "channel": "streaming", "type": "unsubscribe", "turnId": "uuid" }
{ "channel": "streaming", "type": "interjection", "turnId": "uuid", "text": "string", "mode": "append|replace" }
```

- Subscribe includes `lastSeq` + `epoch` for hybrid replay
- Interjection validated using the same DTO/validator as the HTTP endpoint (UUID format, non-empty trimmed content, valid mode enum, reject unknown fields) then routed through `streamingService.UpsertInterjection()`
- Turn-level auth re-checked on every subscribe and interjection

**Server → Client**:

```json
{ "channel": "streaming", "type": "subscribed", "turnId": "uuid", "epoch": "string", "headSeq": 184, "recovered": true, "catchupCount": 5 }
{ "channel": "streaming", "type": "event", "turnId": "uuid", "seq": 42, "event": { /* AG-UI JSON */ } }
{ "channel": "streaming", "type": "ended", "turnId": "uuid", "reason": "completed|error|cancelled|stream_switch",
  "finalSeq": 184, "metadata": { "newAssistantTurnId": "uuid (stream_switch only)" } }
{ "channel": "streaming", "type": "spawn_started", "parentTurnId": "uuid", "spawnTurnId": "uuid" }
{ "channel": "streaming", "type": "interjection_result", "turnId": "uuid", "mode": "queued|created",
  "content": "string (queued only)", "newAssistantTurnId": "uuid (created only)" }
{ "channel": "streaming", "type": "gap", "turnId": "uuid", "fromSeq": 42, "toSeq": 80, "cause": "buffer_expired|server_restart" }
{ "channel": "streaming", "type": "error", "code": "SUBSCRIBE_FAILED|RATE_LIMITED|INTERJECTION_FAILED", "turnId": "uuid" }
```

Notes:
- `subscribed` includes `epoch` + `recovered` flag + `catchupCount`
- `ended` includes `finalSeq` for client-side completeness check. `stream_switch` reason carries `newAssistantTurnId` — this is the only stream-switch signal (replaces SSE `STREAM_SWITCH` event entirely)
- `spawn_started` pushes spawn discovery to client — client auto-subscribes
- `interjection_result` mirrors the HTTP response: `queued` (buffered while streaming) or `created` (follow-up turns created because not streaming, includes new turn ID for subscribe)
- `gap` when replay unavailable — explicit, not silent
- Error codes are generic externally (no turn-existence oracle); details in server logs

**Streaming channel limits**:

| Concern | Limit | Mechanism |
|---------|-------|-----------|
| Max subscriptions/connection | 10 | Channel-level counter |
| Subscribe to unowned turn | Reject | `authorizer.CanAccessTurn()` per subscribe |

### Subscribe + Catchup Contract (Atomic)

Subscribe MUST be atomic with catchup replay. The streaming handler uses `SubscribeWithCatchup` from the mstream library (Phase 0 fix):

1. Handler receives `subscribe` message with `{turnId, lastSeq, epoch}`
2. Handler calls `stream.SubscribeWithCatchup(clientID, lastSeq, epoch)`
3. Library atomically: snapshots buffer state → registers live channel → returns `(catchupEvents, liveChan, streamStatus, err)`
4. If epoch mismatch or lastSeq too old: return `gap` message, client falls back to REST
5. If stream already terminal: return catchup events + immediate `ended`, no live channel
6. Otherwise: send `subscribed` with `recovered: true` + catchup events, then enter live mode from `liveChan`

No event can be duplicated or missed between catchup and live because they're resolved in one atomic operation inside the library.

### Gap Recovery Contract

When client receives a `gap` message (buffer expired, server restart, epoch mismatch):

1. Client calls `GET /api/turns/{turnId}/blocks` — returns persisted blocks + turn status
2. Client reconstructs turn state from blocks (same as initial page load)
3. If turn status is terminal (`complete`/`error`/`cancelled`): done, no re-subscribe
4. If turn status is `streaming`: client sends a fresh `subscribe` with no `lastSeq`/`epoch` (full catchup from current buffer)
5. If turn status is `pending`: client polls or waits for `spawn_started`/other notification

This is the same recovery path as a fresh page load — gap handling degrades to REST, which is always correct.

### Epoch Semantics

- `epoch` is ephemeral (in-memory, per-stream instance). NOT persisted to DB.
- Server restart = all epochs gone. Client reconnects, sends old epoch → server doesn't recognize it → sends `gap` → client falls back to REST.
- This is explicitly declared as non-resumable after restart. No false-positive replay.
- Within a server lifetime: epoch is stable per stream instance, seq is monotonic.

### Collab Channel Messages

All collab message types include `"channel": "collab"`:

```json
{ "channel": "collab", "type": "proposal_accepted", ... }
{ "channel": "collab", "type": "document_updated", ... }
```

### Cross-Channel Ordering

No ordering guarantees between channels. Collab and streaming events on the same connection are delivered independently from separate queues. Clients must NOT infer causal ordering between collab and streaming events.

### Backpressure

**Per-channel bounded queues with fair scheduling and byte budgets**:
- Each streaming subscription has its own send buffer (size 20, matching mstream)
- Fair round-robin across active subscriptions per connection (prevents hot stream starvation)
- Collab has its own queue — no starvation between channels
- **Byte budgets**: 256KB per subscription, 1MB per connection, 5MB per user. Gap/disconnect decisions on bytes, not only event counts. Large tool-result events can exceed count caps without triggering protection.
- Buffer full (count or bytes) → drop events for that stream, send `gap` on next successful write

---

## Interjection Drain Race Fix

### The Race

```
1. DrainAndClear() at tool_executor.go:214 — clears buffer, returns content
2. SwitchStream() at tool_executor.go:230 — DB transactions, turn creation, new stream launch
3. Terminate(ReasonStreamSwitch) at tool_executor.go:270 — triggers cleanup callback
4. Cleanup (stream_runtime.go:192-198): executorRegistry.Remove(turnID), interjectionRegistry.Remove(turnID)

Between steps 1 and 4, executor is still registered.
New interjection → UpsertInterjection sees executor exists → writes to fresh buffer → step 4 removes buffer → lost.
```

Same race at `completion_handler.go:102-163` (INTERJECTION POINT B). Confirmed by 6 independent review agents.

### Fix: InterjectionForwarder with Epoch Fencing

Transport-independent.

**State machine per turn**: `idle → draining(epoch) → forwarded(newTurnID, epoch)` or `idle → draining(epoch) → idle (rollback)`

```go
type phase uint8
const (
    phaseIdle phase = iota
    phaseDraining
    phaseForwarded
)

type turnEntry struct {
    mu      sync.Mutex
    phase   phase
    epoch   uint64
    target  string                               // newTurnID (forwarded phase only)
    active  *mstream.InMemoryInterjectionBuffer   // normal writes go here
    pending *mstream.InMemoryInterjectionBuffer   // held during drain window
}
```

**API**:
- `BeginDrain(turnID) → (epoch, drainedContent, ok)` — sets draining, increments epoch, drains active
- `CompleteDrain(turnID, epoch, newTurnID) → (lateContent, ok)` — epoch match required, sets forwarded, drains pending for transfer
- `Rollback(turnID, epoch) → ok` — epoch match, merges pending back to active, returns idle
- `Route(turnID, content, mode) → (targetTurnID, held, err)` — idle: active; draining: pending; forwarded: redirect

### SwitchStream Atomicity Fix

Put old-turn completion + successor-turn creation in one DB transaction inside `SwitchStream`. Currently separate operations (stream_runtime.go:288-296) with a failure window.

---

## Service Layer Interfaces (Phase 2)

Phase 2 introduces these explicit interfaces to replace concrete dependencies:

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

---

## Frontend WS Architecture

### ProjectWsProvider

A single `ProjectWsProvider` manages the unified WS connection per project. It owns the connection lifecycle and routes messages to channel-specific dispatchers.

```
ProjectWsProvider (one per active project)
  ├── Connection lifecycle (connect, auth, reconnect, heartbeat)
  ├── Channel dispatcher: "collab" → CollabChannelClient
  ├── Channel dispatcher: "streaming" → StreamingChannelClient
  └── Future: "presence" → PresenceChannelClient
```

### React Integration

```tsx
// Provider at project layout level
<ProjectWsProvider projectId={projectId}>
  {/* Collab features use the collab channel */}
  <CollabProvider>
    <DocumentEditor />
  </CollabProvider>

  {/* Thread features use the streaming channel */}
  <StreamingProvider>
    <ThreadView />
  </StreamingProvider>
</ProjectWsProvider>
```

### StreamingChannelClient

- `subscribe(turnId, lastSeq?, epoch?)` → receives events via callback
- `unsubscribe(turnId)`
- `sendInterjection(turnId, text, mode)`
- Auto-subscribes to spawn turns on `spawn_started`
- Auto-subscribes to successor on `ended{reason: "stream_switch"}`
- On `gap` → falls back to `GET /api/turns/{turnId}/blocks` to reconstruct state
- On reconnect → re-subscribes to all active subscriptions with `{lastSeq, epoch}`

---

## Critical Issues Found (review rounds 1+2)

### CRITICAL

| ID | Issue | Fix |
|----|-------|-----|
| C1 | mstream buffer clears immediately on completion — terminal events lost on reconnect. `Buffer.GetSince` can't distinguish cursor-not-found from no-new-events. `PersistAndClear` can drop events. | Delay buffer clear (grace period). Return `(events, found)` from `GetSince`. Fix `PersistAndClear` atomicity. |
| C2 | `STREAM_SWITCH` launches successor before emitting switch event — fast successor can finish before client subscribes, buffer purged. | Retain successor buffers until first subscribe (or TTL). |
| C3 | Interjection drain race — silent user input loss. | InterjectionForwarder with epoch fencing. |

### HIGH

| ID | Issue | Fix |
|----|-------|-----|
| H1 | Event IDs debug-only, not production-ready. | Always-on event IDs. |
| H2 | `StreamSSE` subscribes before catchup — duplicate events. | Atomic `SubscribeWithCatchup` primitive. |
| H3 | `AddClient` on completed stream hangs forever. | Return error or immediately-closed channel. |
| H4 | `SwitchStream` not atomic — partial state on failure. | Single DB transaction. |
| H5 | SSE transport details in service layer (`StreamURL`, `AllowsSSE`). | Transport-neutral return types + explicit interfaces. |
| H6 | `Registry.Register` overwrites caller hooks. | Compose hooks. |
| H7 | Catchup errors silently discarded. | Propagate errors. |
| H8 | Spawn stream discovery underspecified. | `spawn_started` events on project WS. |

### SECURITY

| ID | Issue | Fix |
|----|-------|-----|
| S1 | WS interjection could bypass service layer auth/validation. | Reuse HTTP DTO/validator, route through `UpsertInterjection()`. |
| S2 | Authorization TOCTOU after subscribe. | Re-auth project membership on heartbeat. Tear down all subscriptions on failure. |
| S3 | Pre-auth connection exhaustion. | Global semaphore (100) + per-IP(/64) throttle. |
| S4 | Missing origin enforcement and frame limits. | Build on `coder/websocket` with origin patterns + ReadLimit. |
| S5 | Subscribe errors leak turn existence. | Generic error codes externally. |

---

## Implementation Phases

### Phase 0: mstream Library Fixes
Fix critical bugs that would break WS replay:
- `Buffer.GetSince` → return `(events, found bool)` (C1)
- `PersistAndClear` atomicity (C1)
- Delayed buffer clear on completion (C1)
- Atomic `SubscribeWithCatchup(clientID, lastSeq, epoch) → (catchup, liveChan, status, err)` (H2)
- Terminal-state guard on `AddClient` (H3)
- Event IDs always-on (H1)
- Compose registry hooks (H6)
- Return catchup errors (H7)

### Phase 1: Interjection Drain Race Fix
- New `InterjectionForwarder` with epoch fencing
- Wire into drain+switch at both interjection points
- Make `SwitchStream` atomic (single DB transaction) (H4)
- Concurrent tests: drain-during-inject, epoch stale completion, rollback-on-failure

### Phase 2: Service Layer Transport Neutrality
- Introduce `ActiveTurnHandle`, `ActiveTurnRegistry`, `InterjectionRouter`, `TurnStreamStarter` interfaces
- Remove `StreamURL` from Launch/SwitchStream return types (H5)
- Remove `AllowsSSE` helpers, move keepalive to transport adapter (H5)
- AG-UI emitter stops emitting SSE `STREAM_SWITCH` — replaced by transport-layer `ended{reason: "stream_switch"}`

### Phase 3: Unified WS Framework (`backend/internal/wsutil/`)
Build on `coder/websocket` (not `x/net/websocket` — need origin enforcement, read limits, binary/text frame control):
- `ProjectServer` — upgrade, auth bootstrap, lifecycle orchestration
- `Connection` — write-safe wrapper, channel session factory, panic boundaries
- `ChannelHandler` interface + `ChannelSession` egress API
- `Scheduler` — per-channel outbound queues, fair round-robin, byte-budget enforcement
- `Router` — parse `{channel, type}`, dispatch, reject unknown/missing channels
- Auth module — JWT bootstrap, project membership, re-auth on heartbeat
- Rate limiter, connection registry, pre-auth semaphore

### Phase 4: Migrate Collab to WS Framework
- Extract collab message handling from `collab_project.go` into `collabChannelHandler`
- Implements `ChannelHandler` interface
- Register as `ws.Register("collab", collabHandler)`
- Document Yjs WS (`/ws/documents/{documentId}`) stays separate

### Phase 5: Streaming Channel Handler
- `streamingChannelHandler` implements `ChannelHandler`
- Subscribe/unsubscribe with atomic `SubscribeWithCatchup` (epoch + seq)
- `interjection_result` response message (queued vs created)
- Interjection validation (reuse HTTP DTO/validator) + service layer routing
- Per-subscription fair-scheduled send queues via `ChannelSession.Send()`
- `gap` messages on replay failure with defined REST recovery path
- `spawn_started` push notifications
- Re-authorization on subscribe and interjection
- Successor stream retention: retain completed buffers until first subscribe or TTL

### Phase 6: Frontend WS Client
- `ProjectWsProvider` — manages unified WS connection per project
- Channel dispatchers for collab + streaming
- `StreamingChannelClient` — subscribe, interjection, spawn auto-subscribe, gap recovery
- Reconnection with exponential backoff + jitter + epoch validation
- React context/hooks: `<ProjectWsProvider>`, `useStreamingChannel()`, `useCollabChannel()`

### Phase 7: SSE Cleanup
- Remove `SSEHandler`, `sse/` package, `nethttp` adapter from mstream

---

## Observability

### Metrics (framework-level)

- `ws_connections_active{project}` — gauge
- `ws_connections_total{project}` — counter
- `ws_auth_failures{reason}` — counter (expired, invalid, forbidden)
- `ws_messages_inbound{channel}` — counter
- `ws_messages_outbound{channel}` — counter
- `ws_rate_limited` — counter

### Metrics (streaming channel)

- `ws_subscriptions_active{project}` — gauge
- `ws_events_delivered{project}` — counter
- `ws_events_dropped{project}` — counter (backpressure)
- `ws_gaps_sent{cause}` — counter
- `ws_catchup_replays{recovered}` — counter (true/false)
- `ws_interjections{mode}` — counter (queued/created)
- `ws_subscribe_latency` — histogram
- `ws_catchup_latency` — histogram

### Alerts

- Gap rate > 5% of events → backpressure too aggressive or buffer too small
- Subscription count per connection consistently at limit → client may be leaking subscriptions
- Auth failure spike → possible attack or token refresh issue
- Catchup failure rate > 10% → buffer retention too short

---

## Failure Containment

- **Channel handler panic**: Framework wraps `OnMessage` and `OnDisconnect` in `recover()`. Panicking channel is disabled for that connection; other channels continue. Connection stays alive. Panic logged with stack trace.
- **mstream Registry unavailable**: Subscribe returns error to client. Existing subscriptions continue delivering from their live channels.
- **SwitchStream timeout (30s+)**: InterjectionForwarder's pending buffer holds interjections during drain. If drain never completes, the forwarder has a timeout → `Rollback` → pending content returned to active buffer (or discarded if executor also failed).
- **Slow DB during catchup**: Catchup has a timeout. On timeout, send `gap` to client → client falls back to REST.
- **Write failures**: If `ChannelSession.Send()` fails (broken pipe), framework marks connection dead and triggers disconnect cleanup for all channels.

---

## Key Files

| Area | File |
|------|------|
| **Collab WS (extract into framework)** | |
| Project handler | `backend/internal/handler/collab.go`, `collab_project.go` |
| Auth | `backend/internal/handler/collab_authenticator.go` |
| Message loop | `backend/internal/handler/collab_message_loop.go` |
| Doc handler (security baseline) | `backend/internal/handler/collab_document_handler.go` |
| **mstream (Phase 0)** | |
| Stream | `meridian-stream-go/stream.go` |
| Registry | `meridian-stream-go/registry.go` |
| Buffer | `meridian-stream-go/buffer.go` |
| Handler | `meridian-stream-go/handler.go` |
| Interjection | `meridian-stream-go/interjection.go` |
| **Streaming service (Phase 1-2)** | |
| Interjection service | `backend/internal/service/llm/streaming/interjection.go` |
| Tool executor (drain point A) | `backend/internal/service/llm/streaming/tool_executor.go:210-272` |
| Completion handler (drain point B) | `backend/internal/service/llm/streaming/completion_handler.go:98-165` |
| StreamRuntime | `backend/internal/service/llm/streaming/stream_runtime.go` |
| StreamExecutor | `backend/internal/service/llm/streaming/stream_executor.go` |
| Executor state | `backend/internal/service/llm/streaming/executor_state.go` |
| Deps | `backend/internal/service/llm/streaming/deps.go` |
| SSE handler | `backend/internal/handler/sse_handler.go` |
| **Route registration** | |
| Collab domain | `backend/internal/app/domains/collab.go` |
| LLM domain | `backend/internal/app/domains/llm.go` |
| **Frontend** | |
| Thread transport types | `frontend-v2/src/features/threads/transport-types.ts` |
| Document WS provider (pattern) | `frontend-v2/src/editor/collab/document-ws-provider.ts` |

## Research Artifacts

| Artifact | Location |
|----------|----------|
| WS multiplexing patterns | `.meridian/fs/websocket-multiplexing-production-patterns-2026-03-29.md` |
| Drain race transition patterns | `.meridian/fs/research/drain-race-transition-patterns-2026-03-29.md` |
