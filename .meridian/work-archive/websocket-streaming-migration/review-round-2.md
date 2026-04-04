# Design Review Round 2 — Synthesis

5 reviewers (feasibility, SOLID, protocol, security, completeness). All returned "request changes."

## CRITICAL — Blocks implementation

### RC1. Outbound protocol breaks v1 frontend (p692 Feasibility)
The design changes connect ack to `{"type": "connected", "channels": [...]}` and adds `channel` field to outbound collab messages. But v1 frontend expects `project:connected` and routes `proposal:*` / `doc:error` with no `channel` envelope. Under the proposed protocol, v1 frontend never becomes connected and stops routing collab events.
**Fix**: Server must send both `project:connected` (v1 compat) AND the new `connected` message, or use the old format with additional fields. Outbound collab messages must NOT require `channel` field — add it as optional metadata that v1 ignores.

### RC2. ChannelHandler interface too narrow for streaming (p692 Feasibility, p693 SOLID)
`OnMessage/OnConnect/OnDisconnect` is insufficient. Streaming requires:
- Server-initiated outbound events (spawn_started, ended, gap) — not triggered by client messages
- Per-subscription send queues with fair scheduling
- Isolated backpressure per channel
With the current interface, handlers either need raw conn access (violates SRP/framework control) or the framework absorbs channel-specific logic (violates separation).
**Fix**: Framework needs a `ChannelSession`/`OutboundSink` abstraction. Handlers receive a session object on connect that provides a framework-owned egress API. The framework manages scheduling; channels provide events to send.

### RC3. WS interjection has no success response (p694 Protocol)
`UpsertInterjection()` has two success modes: `queued` (buffered while streaming) and `created` (follow-up turns created because not streaming). If a WS interjection lands after the turn stops streaming, the server creates follow-up turns but the client never learns about them — user-visible input loss.
**Fix**: Add `interjection_result` server message: `{ "channel": "streaming", "type": "interjection_result", "turnId": "...", "mode": "queued|created", "newAssistantTurnId"?: "..." }`

### RC4. Subscribe + catchup still not atomic (p694 Protocol)
Protocol doesn't specify when live subscription activates relative to catchup replay. The mstream library has the same bug: `AddClient()` before catchup = duplicates. `AddClient()` on completed stream = hangs forever. Phase 0 lists fixing this (H2, H3) but the protocol spec doesn't define the contract.
**Fix**: Spec must define: snapshot `headSeq` + terminal state first, replay to boundary, then either enter live mode or immediately send `ended`. This is the `SubscribeWithCatchup` primitive from Phase 0 — protocol must depend on it explicitly.

### RC5. Frontend project WS architecture missing (p696 Completeness)
v2 has no project-scoped WS transport. Only a document-scoped `DocumentWsProvider`. Without an explicit `ProjectWsProvider` / dispatcher / hook structure, implementers will ship a second socket or bury streaming in thread-local state.
**Fix**: Design must specify the frontend WS architecture: `ProjectWsProvider` (manages one connection), channel dispatchers (collab, streaming), React context/hooks structure.

### RC6. Rollout/rollback underspecified (p696 Completeness)
No kill switch. No way for v2 to choose WS vs SSE at runtime. One coupled production migration. If the shared collab+streaming socket misbehaves, no revert path.
**Fix**: Add runtime feature flag for streaming-over-WS. v2 checks flag → WS or falls back to SSE. Collab always works (backward compat). Streaming channel can be disabled independently.

## HIGH — Should fix in design

### RH1. Phase 3 is a rewrite, not extraction (p692 Feasibility)
Current project WS uses `x/net/websocket` with minimal security. The strong security model (origin enforcement, read limits, per-user connection counting) lives in the separate document handler on `coder/websocket`. Phase 3 is a transport library swap + security upgrade + framework extraction on a live endpoint.
**Fix**: Acknowledge this scope in the phase description. Consider building framework on `coder/websocket` from the start.

### RH2. Phase ordering: streaming doesn't need collab migration (p692 Feasibility)
Streaming can ship on a separate endpoint as a fallback without touching collab. Current coupling of Phase 5 to Phase 4 increases blast radius.
**Fix**: Keep the unified framework as the target, but define a fallback: if collab migration stalls, streaming can launch on a separate v2-only endpoint. Phase 4 becomes optional for streaming delivery.

### RH3. Phase 2 interfaces not named (p693 SOLID)
"Introduce interfaces" is too vague. Need explicit:
- `ActiveTurnHandle`: `RequestSoftCancel`, `RequestHardCancel`, `State`, `ThreadID`
- `ActiveTurnRegistry`: `GetByTurn`, `GetByThread`
- `InterjectionRouter`: `Route`, `BeginDrain`, `CompleteDrain`, `Rollback`
- `TurnStreamStarter`: launch/switch returns turn IDs, not transport URLs

### RH4. Protocol contradictions (p693 SOLID)
- stream_switch: protocol says `ended` with `reason: "stream_switch"`, but Phase 6 says frontend reacts to `stream_switch`, and current runtime emits SSE `STREAM_SWITCH` with `StreamURL`
- Auth freshness: S2 says re-auth on heartbeat, protocol/Phase 5 only say subscribe/interjection
**Fix**: One canonical contract. Document the transition from SSE `STREAM_SWITCH` to WS `ended{reason: "stream_switch"}`.

### RH5. Epoch/restart is lossy (p694 Protocol)
Registry is in-memory. Crash = no process to emit `gap`. Catchup only reconstructs persisted state + synthetic `RUN_STARTED`.
**Fix**: Protocol must explicitly declare crash-restart as non-resumable. Client treats epoch mismatch (or connection to fresh server) as full state reset via REST.

### RH6. `gap` recovery contract undefined (p694 Protocol)
"REST fallback" is too vague. Need: specific endpoint (`GET /api/turns/{id}/blocks`), merge algorithm, and how to reconstruct terminal state.
**Fix**: Specify the exact REST recovery path and how client merges REST state with any partially-received WS events.

### RH7. Channel-less fallback breaks isolation (p695 Security)
Defaulting channel-less messages to collab lets any client reach collab parser by omitting `channel`.
**Fix**: Only allow channel-less routing for an explicit allowlist of legacy v1 collab message types. Reject all others.

### RH8. WS interjection must replicate HTTP validation (p695 Security)
HTTP validates UUID format, trimmed non-empty content, mode enum. WS path must replicate all checks, reject unknown fields.
**Fix**: Reuse exact HTTP DTO/validator for WS interjection messages.

### RH9. Byte-based backpressure missing (p695 Security)
Memory cost is per-byte, not per-event. Large tool-result events can exhaust memory before count caps trigger.
**Fix**: Add byte budgets per subscription, connection, and user/project. Gap/disconnect decisions on bytes, not only counts.

### RH10. Testing plan needs concrete layers (p696 Completeness)
No matrix for Go unit vs WS integration vs frontend contract vs E2E.
**Fix**: Define test matrix per phase: which risks get unit tests, which get integration, which need E2E smoke.

### RH11. Observability absent (p696 Completeness)
No metrics, alerts, load profile. Can't verify fair scheduler works or backpressure triggers correctly.
**Fix**: Define metric set: connection count, active subscriptions, queue depth, gap count, dropped events, replay success/failure, auth failures, write latency, catchup latency, reconnect-storm rate.

### RH12. Failure containment undefined (p696 Completeness)
Channel handler panic must not take down the whole connection. Framework needs recovery boundaries.
**Fix**: Framework wraps channel handler calls in recover(). Panicking channel gets disabled for that connection; other channels continue. Connection stays alive.

## MEDIUM — Defer to planning

- M1. Need golden compat tests before collab migration (p692)
- M2. ProjectServer SRP — split into lifecycle + session + registries (p693)
- M3. Frame type confusion — message loop checks `{` first byte, binary could reach JSON parser (p695)
- M4. IPv6 pre-auth throttle — throttle on /64 minimum (p695)
- M5. Cross-tab subscriber isolation — add `subscriberId` or don't share sockets (p695)
- M6. Phase entry/exit gates missing (p696)
- M7. Q3 (binary vs text) not explicitly recorded as decision (p696)
- M8. Cross-channel ordering should be explicitly declared unsupported (p694)
- M9. Malformed JSON / invalid type handling needs explicit protocol behavior (p694)
