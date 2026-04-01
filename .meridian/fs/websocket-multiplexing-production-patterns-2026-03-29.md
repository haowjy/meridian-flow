# WebSocket Multiplexing in Production Streaming Systems

Date: 2026-03-29
Context: Meridian `/ws/streaming` multiplexed AG-UI events for concurrent LLM turns.

## Executive recommendation

Use a **hybrid replay protocol** with:
- one physical WS connection per user,
- per-stream logical IDs,
- per-stream ordered offsets plus server-issued stream epoch,
- connection-level sequencing for diagnostics,
- explicit subscription lifecycle messages,
- periodic heartbeat with ACK timeout,
- bounded replay buffers with clear `gap` fallback semantics,
- and protocol version/capability negotiation at connect.

This aligns with proven patterns from Discord Gateway (opcode envelope + resume), GraphQL WS (operation IDs + bidirectional completion), Centrifugo (offset+epoch recovery), Slack Socket Mode (envelope ACKs + planned refresh disconnects), and Socket.IO (documented delivery/recovery limits).

## 1) Single-connection multiplexed WS patterns

### What production systems do

1. **Operation-ID envelope (GraphQL over WS)**
- Messages carry `type`, `id`, `payload`.
- Multiple operations can be active concurrently; messages interleave by `id`.
- Lifecycle is explicit with `subscribe`, `next`, `error`, `complete`.
- Good fit when many independent logical streams share one socket.

2. **Opcode envelope with global sequence (Discord Gateway)**
- Envelope fields include opcode/event metadata and sequence.
- Client tracks latest sequence and uses it for resume.
- Heartbeat frames include state continuity signal.

3. **ACK envelope delivery (Slack Socket Mode)**
- Server wraps events in an envelope with unique ID; client must ACK (or server retries).
- Separates transport-level delivery acknowledgement from app-level processing.

### Backpressure on one shared socket

Key operational reality: browser `WebSocket` has no built-in backpressure control. If producer outpaces consumer, memory/CPU can degrade badly. In practice, robust systems do **application-level buffering and shedding**.

Patterns that hold up:
- **Per-stream queue + scheduler** (weighted round-robin/deficit round-robin): prevents one hot stream from starving others.
- **Connection high-water/low-water marks** using buffered-amount checks.
- **Coalesce/drop policy for non-critical deltas** (e.g., token chunks), preserve control and terminal events.
- **Disconnect hopelessly slow consumers** and recover via replay path.

The Python `websockets` docs describe why global backpressure against the slowest consumer collapses broadcast throughput and recommend per-client queues / disconnection strategy for laggards.

### Concrete recommendation for `/ws/streaming`

Use this envelope:

```json
{
  "v": 1,
  "type": "event",
  "streamId": "turn-uuid",
  "streamSeq": 184,
  "connSeq": 9021,
  "eventId": "turn-uuid:184",
  "payload": {"...AG-UI event...": true}
}
```

And control frames:
- `subscribe {streamId, lastSeen?: {streamSeq, epoch}}`
- `subscribed {streamId, epoch, headSeq, recovered}`
- `unsubscribe {streamId}`
- `ended {streamId, reason, finalSeq}`
- `gap {streamId, fromSeq, toSeq, cause}`
- `ping / pong`

## 2) Reconnection and catchup protocols

### Option A: client-tracked sequence only

How it works:
- Client tracks last seq and sends on resubscribe.

Pros:
- Stateless server protocol.
- Simple to reason about.

Cons:
- Fails when in-memory history is gone or rolled.
- Cannot detect stream reset cleanly without extra marker.
- More false-success resumes after restart unless server adds epoch/reset token.

### Option B: server-side cursor/session only

How it works:
- Server stores connection/session recovery state with TTL.

Pros:
- Thin clients.
- Easy reconnect UX for short disconnects.

Cons:
- Server memory pressure at scale.
- Recovery success coupled to TTL + node affinity + adapter support.

### Option C: hybrid (recommended)

How it works:
- Client sends last seen seq.
- Server validates with stream epoch/session context.
- If replay possible, returns missed events.
- If not possible, returns explicit `gap` / unrecoverable and instructs DB/state catchup.

Why this is strongest in practice:
- Discord resume = sequence + session context.
- Centrifugo recovery = `offset + epoch`, with explicit `recovered` true/false and hard limits.
- Socket.IO docs explicitly warn default delivery is at-most-once and recovery is best-effort.

### Handling disconnect gap with in-memory TTL buffers

Required behavior:
1. Keep bounded ring buffer per active stream (size + TTL).
2. On resubscribe with `{streamSeq, epoch}`:
- if epoch mismatch or seq too old => send `gap` and require authoritative catchup.
- if within buffer => replay missed range, then live tail.
3. Include `recovered: boolean` in subscribe acknowledgement.
4. Add reconnect-storm protection (jitter + capped replay batch + pagination if needed).

Anti-pattern:
- pretending replay succeeded when history expired. Always emit explicit unrecoverable signal.

## 3) Heartbeat, liveness, and JWT expiry

### Heartbeat patterns in production

- RFC 6455 defines Ping/Pong as the protocol mechanism for liveness and keepalive.
- Discord: server provides heartbeat interval in Hello; client sends heartbeat with latest seq and expects ACK; missing ACK triggers reconnect.
- Socket.IO defaults are instructive operationally: `pingInterval=25s`, `pingTimeout=20s`.
- Python `websockets` default guidance is similar (20s ping / 20s timeout), explicitly to survive proxy idle closes.
- Infra reality: HTTP/1.1 infrastructure often drops idle around 30–120s; ALB default idle timeout is 60s.

### Recommended values for Meridian

- Send ping every **20–25s**.
- Mark dead after **~20s** without pong/ack.
- Declare connection unhealthy after **1 missed ACK** for fast failover (or 2 for high-latency tolerance).
- Add random jitter to first heartbeat/reconnect to avoid herd effects.

### JWT expiry on long-lived connections

Observed production models:
1. **In-band token refresh** (Centrifugo, Ably SDKs): refresh before expiry, keep socket alive.
2. **Hard close on expiry then reconnect with new token**: simpler, but creates reconnect churn.

For Meridian now:
- Current design (close on expiry during heartbeat) is acceptable if reconnect+resubscribe is robust.
- If token TTL is short or reconnect storms are costly, add optional `auth.refresh` command later.

## 4) Subscription lifecycle and orphan cleanup

### Proven lifecycle patterns

- GraphQL WS: both client and server may send `complete`; both sides must tolerate in-flight race and ignore already-completed IDs.
- Socket.IO rooms: automatic leave on disconnect; no manual teardown required for disconnect case.
- Centrifugo: unsubscribe/disconnect closes stream and SDK resubscribe behavior is code-driven.

### Recommended lifecycle contract for `/ws/streaming`

- Explicit subscribe/unsubscribe messages.
- Server emits `ended` when turn completes/errors/cancels.
- Client should ACK terminal receipt (`endedAck`) for observability; server still auto-cleans without ACK after grace timeout.
- Auto-unsubscribe on:
  - socket disconnect,
  - auth expiry close,
  - stream end + grace expiry,
  - backend stream disposal.
- Background sweeper for orphaned subscriptions and stale replay buffers.

Anti-patterns:
- relying only on client unsubscribe for cleanup,
- keeping ended streams subscribed indefinitely,
- no idempotency for duplicate subscribe/unsubscribe frames.

## 5) Protocol versioning and forward compatibility

### What strong protocols do

- Negotiate protocol via `Sec-WebSocket-Protocol` and/or explicit version field.
- Keep stable message type registry.
- Use explicit close/error codes for protocol violations.
- Support capability discovery in handshake ACK.

Examples:
- RFC 6455 supports subprotocol negotiation and version advertisement.
- Discord versions gateway via URL parameter (`?v=...`) and encoding flags.
- GraphQL WS standardizes subprotocol token `graphql-transport-ws` and strict message types.

### Recommended versioning shape

Handshake:

```json
{ "type": "hello", "protocol": "meridian-stream.v1", "features": ["replay","interjection"] }
```

Server ack:

```json
{ "type": "hello_ack", "protocol": "meridian-stream.v1", "features": ["replay","interjection","endedAck"] }
```

Compatibility rules:
- Unknown `type` => reject with structured protocol error (or ignore only if policy says optional extension).
- Unknown fields inside known message => ignore unless marked required.
- Keep required fields minimal and immutable once released.
- Reserve error-code ranges; document them.

## Practical pitfalls and anti-patterns

1. **Single FIFO write path without fairness**
- One noisy stream starves all others.

2. **Unbounded replay buffer**
- Memory blowups during disconnect storms.

3. **No epoch/reset token**
- False-positive replay success after process restart.

4. **Implicit liveness only (TCP-level trust)**
- Broken sessions linger; reconnection delayed.

5. **Client-only cleanup semantics**
- Orphaned subscriptions, zombie buffers.

6. **No explicit unrecoverable gap signal**
- Silent data loss masked as success.

## Suggested protocol decisions for Meridian now

1. Adopt **hybrid replay**: per-stream `streamSeq` + server `epoch` + explicit `recovered`/`gap`.
2. Add **fair scheduling + per-stream queues** for shared socket backpressure.
3. Keep **heartbeat at 20–25s** and timeout around 20s; include reconnect jitter.
4. Implement **server-side auto cleanup** on disconnect/end; treat client ACK as optional telemetry.
5. Negotiate and pin **`Sec-WebSocket-Protocol: meridian-stream.v1`** plus feature bits.
6. Define and document close/error codes early (including auth expired, bad message, replay unavailable).

## Notes about specific systems requested

- **Discord and Slack** expose concrete, public, production-grade WS protocol behavior and were used heavily here.
- **Figma** publicly describes client/server WS multiplayer and reconnect model (fresh snapshot + local reapply), but not a low-level public wire protocol spec in the same way as Discord/GraphQL WS.
- **VS Code Live Share** does not publish protocol details at the same level of wire-spec fidelity in official docs; treat it as a conceptual reference, not a source for message-level patterns.

## Sources

- Discord Gateway docs: https://docs.discord.com/developers/events/gateway
- Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode/
- GraphQL over WebSocket protocol (`graphql-transport-ws`): https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md
- Socket.IO delivery guarantees: https://socket.io/docs/v4/delivery-guarantees/
- Socket.IO connection state recovery: https://socket.io/docs/v4/connection-state-recovery/
- Socket.IO server heartbeat defaults: https://socket.io/docs/v4/server-options/
- Socket.IO rooms/disconnection cleanup: https://socket.io/docs/v4/rooms/
- Centrifugo history + recovery (`offset`/`epoch`, TTL): https://centrifugal.dev/docs/5/server/history_and_recovery
- Centrifugo connection expiration/refresh: https://centrifugal.dev/docs/3/server/authentication
- Ably token auth + realtime refresh: https://ably.com/docs/auth/token
- Ably auth authorize/upgrade current realtime connection: https://ably.com/docs/api/realtime-sdk/authentication
- MDN WebSocket backpressure limits: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- MDN WebSockets API overview: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/index.html
- Python websockets keepalive guidance: https://websockets.readthedocs.io/en/stable/topics/keepalive.html
- Python websockets broadcast/backpressure patterns: https://websockets.readthedocs.io/en/stable/topics/broadcast.html
- RFC 6455 (Ping/Pong, close semantics, subprotocol/version negotiation): https://datatracker.ietf.org/doc/html/rfc6455
- AWS ALB idle timeout default: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html
- Figma multiplayer architecture blog: https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
