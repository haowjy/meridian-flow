# WebSocket Smoke Tests

Reference material for verifying the WebSocket streaming system. Each doc describes a scenario, how to reproduce it with the toy client, and what failure looks like.

## System Overview

Two project-scoped WebSocket endpoints share a generic wire protocol (`wsutil` framework):

| Endpoint | Purpose | Handler |
|---|---|---|
| `/ws/projects/{id}/threads` | Turn streaming, interjections, spawn discovery | `TurnStreamHandler` |
| `/ws/projects/{id}/docs` | Document/proposal notifications, Yjs CRDT sync | `DocHandler` |

All messages use a JSON envelope with `kind` discriminator (`control`, `notify`, `stream`, `error`). Binary frames use a `<subId>\x00<payload>` prefix for Yjs data.

## Setup

```bash
# Install the toy client
cd .meridian/fs/smoke/websocket/client
npm install

# Get an auth token (project-specific)
source scripts/get-token.sh
export PID=<project-uuid>
export PORT=<backend-port>
```

Usage:
```bash
node client/ws-client.mjs ws://localhost:$PORT/ws/projects/$PID/threads --token $ACCESS_TOKEN [flags]
```

## Toy Client Flags

| Flag | Description |
|---|---|
| `-token` | JWT for auth |
| `-subscribe type:id` | Subscribe to a resource |
| `-last-seq N` | Last seq for reconnect catchup |
| `-epoch STRING` | Epoch for reconnect |
| `-flood N` | Send N messages rapidly |
| `-no-pong` | Don't respond to pings |
| `-freeze-after N` | Stop reading after N events |
| `-bad-auth` | Send invalid auth token |
| `-binary` | Expect binary frames (Yjs) |
| `-interject TEXT` | Send interjection text |
| `-v` | Verbose output |

## Scenarios by Area

### Thread WS
- [Streaming Lifecycle](thread-ws/streaming-lifecycle.md) — connect → auth → subscribe → events → ended
- [Interjection](thread-ws/interjection.md) — send interjection, queued vs created modes
- [Stream Switch](thread-ws/stream-switch.md) — interjection at tool boundary → stream switch → auto-follow
- [Spawn Discovery](thread-ws/spawn-discovery.md) — spawn_started notify → auto-subscribe

### Doc WS
- [Notify Invalidation](doc-ws/notify-invalidation.md) — proposal/document notify → TanStack invalidation
- [Yjs Sync](doc-ws/yjs-sync.md) — subscribe to document → Yjs binary frames → CRDT sync
- [Yjs Multiplexing](doc-ws/yjs-multiplexing.md) — multiple documents on one connection

### Framework
- [Auth and Heartbeat](framework/auth-and-heartbeat.md) — JWT auth, heartbeat re-auth, revocation
- [Rate Limiting](framework/rate-limiting.md) — 30 msg/s limit

### Edge Cases
- [Backpressure](edge-cases/backpressure.md) — frozen client → queue overflow → gap → subscription terminated
- [Reconnect Catchup](edge-cases/reconnect-catchup.md) — disconnect → reconnect with epoch/lastSeq → replay
- [Reconnect Stale Epoch](edge-cases/reconnect-stale-epoch.md) — reconnect after server restart → gap → REST fallback
- [Two-Gap Livelock](edge-cases/two-gap-livelock.md) — gap → subscribe → gap → stop
- [Stream Switch Race](edge-cases/stream-switch-race.md) — interjection during drain window → forwarded to successor
- [Missed Stream Switch](edge-cases/missed-stream-switch.md) — disconnect during switch → REST discovery
- [Subscription Slot Exhaustion](edge-cases/subscription-slot-exhaustion.md) — 10 stream switches → EndSub frees slots
- [Panic Recovery](edge-cases/panic-recovery.md) — handler panic → connection survives
- [Heartbeat Auth Revocation](edge-cases/heartbeat-auth-revocation.md) — lose project access → connection torn down

## Related Code

| Area | Path |
|---|---|
| Framework | `backend/internal/wsutil/ws.go`, `protocol.go`, `auth.go` |
| Thread handler | `backend/internal/handler/thread_ws_handler.go` |
| Doc handler | `backend/internal/handler/doc_ws_handler.go` |
| mstream library | `meridian-stream-go/stream.go`, `registry.go`, `buffer.go` |
| Interjection router | `backend/internal/service/llm/streaming/interjection_router.go` |
| Integration tests | `backend/internal/handler/smoke_ws_test.go` |
