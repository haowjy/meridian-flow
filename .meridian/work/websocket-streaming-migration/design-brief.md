# WebSocket Streaming Migration — Design Brief

Replace per-turn SSE connections with a single multiplexed WebSocket per user for LLM streaming. Fixes SSE connection starvation and enables fixing the interjection drain race.

## Problems Being Solved

### 1. SSE Connection Starvation (CRITICAL)
Each streaming turn opens a separate `GET /api/turns/{id}/stream` SSE connection. HTTP/1.1 browsers allow ~6 connections per origin. With a parent agent + 3 spawned agents, you're at 4 SSE connections — leaving 2 for all other API calls (listing threads, creating turns, fetching documents). More spawns = deadlock.

### 2. Interjection Drain Race (HIGH)
User sends interjection via `PUT /api/turns/{id}/interjection` (separate HTTP request). Executor drains the buffer at a tool boundary. Between drain and follow-up turn creation, another interjection can land in the old buffer that's about to be deleted. User input silently lost. A bidirectional WebSocket lets interjections flow through the same connection, enabling server-side sequencing against drain timing.

## Current Architecture

### SSE Flow
```
Frontend                          Backend
────────                          ───────
EventSource(/api/turns/T1/stream) ──→ SSEHandler → Registry.Get(T1) → Stream.AddClient
EventSource(/api/turns/T2/stream) ──→ SSEHandler → Registry.Get(T2) → Stream.AddClient
EventSource(/api/turns/T3/stream) ──→ SSEHandler → Registry.Get(T3) → Stream.AddClient
PUT /api/turns/T1/interjection    ──→ ThreadHandler → InterjectionRegistry.Upsert
```
Each turn = 1 TCP connection. N turns = N connections.

### Key Components
| Component | Location | Role |
|-----------|----------|------|
| `mstream.Stream` | `meridian-stream-go/stream.go` | Event buffering, client multiplexing, WorkFunc lifecycle |
| `mstream.Registry` | `meridian-stream-go/registry.go` | Stream lookup by turn ID |
| `nethttp adapter` | `meridian-stream-go/adapters/nethttp/handler.go` | SSE framing + HTTP handler |
| `SSEHandler` | `backend/internal/handler/sse_handler.go` | HTTP handler, auth, keepalive, reconnection |
| `AG-UI Emitter` | `backend/internal/service/llm/streaming/agui/emitter.go` | JSON event serialization |
| `InterjectionRegistry` | `meridian-stream-go/interjection.go` | Per-turn interjection buffers |
| Collab WebSocket | `backend/internal/handler/collab.go` | Existing WS infra (auth, heartbeat, rate limiting) |

### What's Already Transport-Agnostic
- **AG-UI protocol** — pure JSON serialization. Emitter produces `mstream.Event` structs, doesn't know about SSE.
- **mstream.Stream** — manages event channels and buffers internally. SSE is just one adapter.
- **Streaming service layer** — StreamRuntime, StreamExecutor, Terminate, SwitchStream — none touch transport.
- **Interjection** — `InterjectionBuffer` is an in-memory channel, not HTTP-coupled.

### What's SSE-Specific
- `SSEHandler` — HTTP handler with SSE headers, `text/event-stream`, keepalive comments
- `nethttp adapter` — SSE framing (`event:`, `data:`, `id:`)
- `Last-Event-ID` reconnection — native SSE header, no WebSocket equivalent
- Frontend `EventSource` — browser-native SSE client

## Target Architecture

### WebSocket Flow
```
Frontend                              Backend
────────                              ───────
WS /ws/streaming (single connection) ──→ StreamingWSHandler
  → {"subscribe": "T1"}              ──→ Registry.Get(T1) → Stream.AddClient
  → {"subscribe": "T2"}              ──→ Registry.Get(T2) → Stream.AddClient
  ← {"turn":"T1", "event": {...}}    ←── AG-UI event routed from T1
  ← {"turn":"T2", "event": {...}}    ←── AG-UI event routed from T2
  → {"interjection": "T1", "text":…} ──→ InterjectionRegistry.Upsert (same connection)
  → {"unsubscribe": "T1"}            ──→ Stream.RemoveClient
```
All turns = 1 TCP connection. Interjections flow through same pipe.

### Component Changes

| Component | Change | Effort |
|-----------|--------|--------|
| **mstream library** | Add WebSocket adapter (mirrors nethttp pattern) | ~300 LOC |
| **Backend handler** | New `StreamingWSHandler` at `/ws/streaming` | ~400 LOC |
| **Protocol messages** | Subscribe/unsubscribe/interjection/reconnect message types | ~50 LOC |
| **SSEHandler** | Keep for backwards compat during transition, then delete | None initially |
| **AG-UI Emitter** | No change (already JSON) | Zero |
| **Streaming service** | No change | Zero |
| **Frontend (v2)** | Implement `connectStream()` with WebSocket client | ~800 LOC |
| **Frontend (v1)** | Replace EventSource with WS client (if v1 still active) | ~800 LOC |

### Protocol Messages (Client → Server)
```typescript
// Subscribe to a turn's stream (replaces opening an EventSource)
{ "type": "subscribe", "turnId": "uuid", "lastEventId"?: "string" }

// Unsubscribe from a turn's stream (replaces closing EventSource)
{ "type": "unsubscribe", "turnId": "uuid" }

// Send interjection (replaces PUT /api/turns/{id}/interjection)
{ "type": "interjection", "turnId": "uuid", "text": "string" }

// Heartbeat ACK
{ "type": "pong" }
```

### Protocol Messages (Server → Client)
```typescript
// AG-UI event for a specific turn (replaces SSE event stream)
{ "type": "event", "turnId": "uuid", "eventId": "string", "event": { /* AG-UI JSON */ } }

// Subscription confirmed (with catchup events if reconnecting)
{ "type": "subscribed", "turnId": "uuid" }

// Stream ended (turn completed/errored/cancelled)
{ "type": "ended", "turnId": "uuid", "reason": "completed" | "error" | "cancelled" }

// Heartbeat
{ "type": "ping" }
```

## Design Considerations

### Auth
Reuse collab's JWT bootstrap pattern: first message on WS contains auth token, verified before entering message loop. Token expiry checked on heartbeat; connection closes on expiry (same as collab — no mid-connection refresh).

### Reconnection
SSE has native `Last-Event-ID`. WebSocket needs explicit sequence tracking:
- Server includes `eventId` in every event message
- Client tracks last received `eventId` per turn
- On reconnect, client re-subscribes with `lastEventId` — server replays from buffer or falls back to DB catchup (same logic as current `buildCatchupFunc`)

### Interjection Drain Race Fix
With interjections flowing through the same WebSocket:
- Server receives interjection message in the WS read loop
- WS handler writes to InterjectionBuffer (same as current PUT handler)
- BUT: the WS handler can coordinate with the executor's drain — e.g., hold a lock during drain+create so no interjection can land in the gap
- Alternative: sequence numbers on interjections, executor checks sequence after drain

### Backpressure
If a client is slow to read, the WebSocket write buffer fills. Options:
- Drop events for slow clients (client reconnects and catches up via `lastEventId`)
- Buffer with bounded size (match mstream's current 20-event buffer)
- Collab's pattern: `writeMu sync.Mutex` serializes writes, slow client blocks other events to that client only (not other clients)

### STREAM_SWITCH Event
Currently the frontend receives STREAM_SWITCH on the old turn's SSE, then opens a new EventSource for the new turn. With WebSocket: frontend receives STREAM_SWITCH, sends `{"subscribe": newTurnId}` on the same connection. No new TCP connection needed.

### Spawn Streams
Parent agent spawns children → children start streaming → frontend subscribes to all on the same WebSocket. The thread tree API already returns spawn turn IDs. Frontend subscribes as spawns start.

## What NOT to Change
- StreamRuntime, StreamExecutor, Terminate, SwitchStream — untouched
- AG-UI event format — untouched
- mstream.Stream core (buffering, WorkFunc) — untouched
- Turn creation pipeline — untouched
- InterjectionBuffer interface — untouched (WS handler calls same Upsert method)

## Open Questions for Design Phase
1. **One WS per project or per user?** Per-user is simpler (all streams regardless of project). Per-project matches collab's scoping.
2. **Collab + streaming on same WS?** Could multiplex both, but mixing concerns adds complexity. Separate WS connections for separate concerns is probably cleaner (still only 2 connections total vs N).
3. **Binary vs text frames?** AG-UI is JSON, so text frames are natural. Could use binary (msgpack/protobuf) later for performance, but premature now.
4. **v1 frontend support?** If v1 is being replaced by v2, maybe only implement WS client in v2 and leave v1 on SSE until deprecated.
5. **Graceful SSE deprecation?** Keep SSE endpoint during transition? Or hard-cut?
