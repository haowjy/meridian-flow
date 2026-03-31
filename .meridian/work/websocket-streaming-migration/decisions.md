# WebSocket Streaming Migration — Decision Log

## Carried Forward (prior design rounds)

### D1. Per-project multiplexed WS over per-thread WS
**Decision**: Multiplex all streaming turns on a per-project WS.
**Why**: Spawns create separate threads — parent + 3 spawns = 5 threads. Per-thread WS means 5 independent connections, 5 auth/heartbeat/reconnection state machines, and no built-in spawn discovery. Multiplexed: one connection, server pushes spawn notifications, frontend subscribes. WS connections are NOT subject to HTTP/1.1 ~6 limit — multiplexing is justified by spawn management simplicity.
**Considered**: Per-user WS (simpler, but awkward for project-scoped features), per-thread WS (doesn't solve spawn management), per-thread-tree (novel abstraction with no precedent).

### D4. Interjection drain race fix is transport-independent
**Decision**: Fix via InterjectionForwarder with epoch fencing in the streaming service layer.
**Why**: All review agents confirmed the race is between `DrainAndClear()` and executor cleanup — service internals, not transport. The forwarder works regardless of how interjections arrive.

### D5. Hybrid replay with epoch, crash = non-resumable
**Decision**: Client sends `{lastSeq, epoch}` on reconnect. Epoch is ephemeral (in-memory). Server restart = epochs gone = client gets `gap` = falls back to REST.
**Why**: Matches Discord/Centrifugo patterns. Explicitly non-resumable after restart avoids false-positive replay. REST fallback is always correct.

### D6. Build on `coder/websocket`, not `x/net/websocket`
**Decision**: Framework uses `coder/websocket` library.
**Why**: `x/net/websocket` (current project WS) lacks origin enforcement, read limits, binary/text frame control, and per-message compression support. `coder/websocket` (current document WS) has all of these.

### D7. Document Yjs WS stays separate
**Decision**: `/ws/documents/{documentId}` is not merged into the new framework.
**Why**: Binary CRDT frames, completely different protocol, per-document scoping. May adopt shared auth/heartbeat utilities from `wsutil` later.

### D8. SwitchStream atomicity
**Decision**: Put old-turn completion + successor-turn creation in one DB transaction.
**Why**: Currently separate operations. DB failure between = partial state.

### D9. Heartbeat 20s interval, 20s timeout
**Decision**: Align with production system defaults (Discord, Socket.IO, Centrifugo).
**Why**: 30s/5s is slower to detect dead connections. AWS ALB default idle timeout is 60s.

### D11. Interjection result message
**Decision**: Add `interjection_result` control message with `mode: "queued|created"`.
**Why**: `UpsertInterjection()` can create follow-up turns (not-streaming fallback). Without a result message, the client never learns about created turns. Silent input loss.

### D12. Atomic subscribe+catchup
**Decision**: `SubscribeWithCatchup` is a single atomic operation in mstream. Protocol spec depends on this.
**Why**: Separate subscribe + catchup = duplicates (live events during catchup replay). The atomic primitive resolves catchup and registers the live channel in one step.

### D13. Text frames only, binary rejected
**Decision**: Framework rejects non-text WebSocket frames for channel-routed traffic.
**Why**: All channels use JSON. Binary frames reaching JSON parsing is a security concern.

### D14. Byte-based backpressure budgets
**Decision**: Gap/disconnect decisions based on byte budgets (256KB/subscription, 1MB/connection, 5MB/user), not only event counts.
**Why**: Large tool-result events can exhaust memory before count caps trigger.

### D15. Panic isolation per handler
**Decision**: Framework wraps handler calls in `recover()`. Panicking handler disabled for that connection; others continue.
**Why**: Streaming handler panic must not take down other handlers on the same connection.

### D16. SSE `STREAM_SWITCH` replaced by `ended{reason: "stream_switch"}`
**Decision**: No separate STREAM_SWITCH event type. The WS `ended` message with `reason: "stream_switch"` and `payload.newAssistantTurnId` is the canonical stream-switch signal.
**Why**: One canonical contract. The old SSE event carried `StreamURL` which is transport-specific.

## New Decisions (generic protocol redesign)

### D17. Two WS connections per project, not one unified connection
**Decision**: Separate `/ws/projects/{projectId}/threads` and `/ws/projects/{projectId}/docs` endpoints.
**Why**: User decision. Threads and docs are separate concerns. Separate connections give: independent lifecycle (doc WS failure doesn't affect streaming), simpler failure containment, cleaner authorization scoping, and separate backpressure domains. Trade-off: two connections instead of one. Acceptable because WS connections are cheap and the concerns are genuinely independent.
**Considered**: Unified connection with channel routing (prior design). Rejected by user — coupling concerns that don't need to be coupled.

### D18. Generic reusable protocol with three lanes
**Decision**: Both connections share identical wire format: control lane (lifecycle), notify lane (lightweight invalidation), stream lane (opt-in heavy data).
**Why**: Protocol reusability was a user requirement. Creating a third WS connection type should be plugging in handlers, not copying infrastructure. The three-lane split is informed by production patterns (GraphQL WS lifecycle, TanStack invalidation, Centrifugo multiplexing).
**Considered**: Per-connection custom protocols (simpler per-connection, but duplicates infrastructure). Channel-routed multiplexing on one connection (prior design — rejected in D17).

### D19. Notify lane = cache invalidation only (TanStack Query pattern)
**Decision**: Notify events are tiny hints (`resource type + ID + event name + optional metadata`). Frontend uses these to call `invalidateQueries()`. No full data through notify.
**Why**: User decision. Separates "something changed" (notify) from "here's the data" (REST/stream). Prevents notify lane from becoming a second data channel. Duplicates are harmless (just trigger a refetch). Matches TanStack Query invalidation pattern proven at scale.
**Considered**: Notify with full data payloads (prior collab WS pattern). Rejected — couples notification transport to data shape, makes notify events large and complex.

### D20. Stream lane = explicit opt-in subscriptions
**Decision**: Client must `subscribe` via control lane before receiving stream events. Supports seq/epoch for replay, gap detection, backpressure.
**Why**: Heavy data (AG-UI events, future Yjs) should only flow when explicitly requested. Subscribe lifecycle gives the server clear resource management boundaries (know when to allocate/deallocate buffers). Seq/epoch enable reconnection without data loss within a server lifetime.

### D21. No SSE fallback, no v1 backward compatibility
**Decision**: Clean break. No dual-format complexity.
**Why**: User decision. No real users or user data. Schema can change freely (per CLAUDE.md). The v1 frontend will be migrated simultaneously.
**Considered**: Runtime feature flag for WS vs SSE (prior review suggestion RC6). Rejected by user — unnecessary complexity for a greenfield project.

### D22. Observability deferred
**Decision**: Structured logging with turn/connection IDs is sufficient. No metrics, dashboards, or alerts.
**Why**: User decision. No real users exist yet. When they do, observability can be added without changing the protocol or framework architecture.

### D23. Handler interface with explicit subscribe/unsubscribe
**Decision**: Handler interface separates `OnSubscribe`/`OnUnsubscribe` from `OnMessage`, rather than routing all operations through `OnMessage`.
**Why**: Prior design (D10) used a flat `OnMessage` + `ChannelSession` pattern. The generic protocol with explicit subscribe/unsubscribe lifecycle benefits from the framework knowing about subscription state — it can enforce limits (10/connection), track active subscriptions for reconnection, and manage per-subscription backpressure queues. Handlers focus on business logic, not lifecycle bookkeeping.
**Considered**: Flat `OnMessage` routing (prior design). Works but pushes subscription lifecycle management into each handler.

### D24. Separate `Session.SendToSub` and `Session.Notify` methods
**Decision**: Session egress API has three methods: `Send` (control/error), `SendToSub` (stream events via per-subscription queues), `Notify` (broadcast notify events).
**Why**: Stream events route through per-subscription queues with fair scheduling and byte budgets. Notify events bypass subscription queues entirely — they're broadcast, not subscription-scoped. Mixing them through one `Send` method would require the handler to specify routing intent on every call, which is error-prone.

### D25. Resource-type-based handler routing (not channel names)
**Decision**: Handlers register by resource type (`"turn"`, `"document"`). Framework routes messages by `resource.type` in the envelope.
**Why**: Prior design used channel names (`"streaming"`, `"collab"`). The generic protocol routes by resource type naturally — the `resource` field is already in every message. This eliminates the `channel` field and simplifies the envelope. Multiple resource types can register on the same connection, and the same resource type handler can be reused across connections.
**Considered**: Channel-based routing (prior design). Adds a field that duplicates information already in `resource.type`.

## Review Round Fixes (post-review)

### D26. Two consecutive gaps = stop retrying (anti-livelock)
**Decision**: If a client gets a gap, falls back to REST, REST says "streaming", and re-subscribe also returns gap — stop. Render persisted blocks, wait for notify.
**Why**: Review finding (p700 #1). After server restart, the in-memory stream is gone but DB status may still say "streaming" (async status update). gap→subscribe→gap would loop forever. Two consecutive gaps proves the server can't serve this stream.
**Considered**: Server-side "I restarted" signal. More complex, and the client-side two-gap rule is simpler and handles all in-memory-loss cases uniformly.

### D27. Successor turn ID persisted in response_metadata for REST discovery
**Decision**: `SwitchStream` writes `successor_turn_id` to the completed turn's `response_metadata`. Frontend can discover successors via REST when it misses the WS `ended{reason: stream_switch}` event.
**Why**: Review finding (p700 #2). If the WS disconnects during a stream switch, the client has no way to find the successor turn without this field. REST is the recovery path — it must be complete.

### D28. Framework owns subscription state; handler owns mstream state
**Decision**: The framework is the single source of truth for active subIds, enforces limits, manages per-subscription send queues. Handlers only track mstream-specific state (live channels, goroutines). No double bookkeeping.
**Why**: Review finding (p701 #1). Prior design had subscription maps in both framework and handler — divergence risk on error paths. Single ownership eliminates the class of bugs.

### D29. Broadcaster is separate from Session
**Decision**: `Session` is per-connection egress. `Broadcaster` is project-wide broadcast. They are separate interfaces. `DocNotifier` wraps `Broadcaster` with typed methods.
**Why**: Review finding (p701 #2). Prior design had `Session.Notify()` described as both per-connection and project-wide. Separate interfaces make the scope explicit.

### D30. Backpressure gap is terminal for the subscription
**Decision**: When byte budget overflows, the subscription is terminated — gap sent, handler cleaned up. No partial delivery after a gap. `ended` events bypass the byte-budget check.
**Why**: Review finding (p701 #3). Delivering events after a gap creates confused client state (missing seq in the middle). Terminal gap is cleaner — client re-subscribes or falls back to REST. `ended` is exempt because the client needs the terminal signal (especially stream_switch with successor info).

### D31. ISP split: Handler vs StreamHandler
**Decision**: Base `Handler` interface has `OnConnect`/`OnDisconnect` only. `StreamHandler` extends it with `OnSubscribe`/`OnUnsubscribe`/`OnMessage`. Framework checks interface type and rejects subscribe messages for base handlers.
**Why**: Review finding (p701 #4). Doc notify handler was forced to implement 5 stub methods. ISP violation. The split means notify-only handlers implement 2 methods.

### D32. Security: 20s heartbeat TOCTOU is acceptable
**Decision**: Accept the 20s window between heartbeats where a revoked user can still receive events. Do not add per-message auth checks.
**Why**: Review finding (p702 #1). Per-message auth would be prohibitively expensive (DB check per event). 20s is acceptable for a single-owner application with no real users yet. The heartbeat re-auth catches revocations within one cycle. If tighter access control is ever needed, an in-memory revocation cache (invalidated by the auth service) can reduce the window without per-message DB calls.

### D33. Security: Notify lane project-scope auth is acceptable
**Decision**: Notify events are delivered to all connections for a project without per-resource auth. This is acceptable because the current auth model is single-owner (project access = resource access).
**Why**: Review finding (p702 #2). Adding per-resource auth to the notify lane would require checking every connection's access to every resource on every notification — O(connections × resources). For a single-owner model where project access implies resource access, this is unnecessary. If ACLs are added in the future, the notify lane can be filtered per-connection at that time.

## Implementation Planning Decisions

### D-P1. Merge R4+R10 into Phase 1 instead of separate phases
**Decision**: InterjectionRouter interface extraction (R4) and SwitchStream atomicity fix (R10) are combined into one phase.
**Why**: Both modify `stream_runtime.go`, `tool_executor.go`, and `completion_handler.go`. Separate phases would create merge conflicts and add a round to the critical path.
**Considered**: Separate phases for cleaner scope. Rejected — file overlap makes this impractical.

### D-P2. Merge R6+R9+R7+InterjectionForwarder into Phase 2
**Decision**: StreamURL removal, config struct, noise cleanup, and InterjectionForwarder implementation are combined into one large phase.
**Why**: All touch the same ~6 files in `streaming/`. Each is individually small-to-medium. Keeping them separate would extend the critical path from 5 rounds to 7 rounds.
**Risk accepted**: Phase 2 is the largest service-layer phase. Mitigated by: opus model assignment, focused unit-tester for forwarder state machine, thorough concurrency review.
**Considered**: Three separate sequential phases. Cleaner scope but +2 rounds on critical path.

### D-P3. Auth consolidation runs in Round 1 with no hard dependents
**Decision**: Phase 3 (auth extraction) scheduled in Round 1 even though no later phase strictly requires it.
**Why**: Front-loading work. If done early, Phases 5 and 6 benefit from clean `authenticateToken()` primitive. If delayed, they inline auth — dirtier but functional.

### D-P4. Doc WS is a soft dependency for Thread WS
**Decision**: Phase 7 (Thread WS) ideally starts after Phase 6 (Doc WS) to validate the framework. But it's not a hard dependency — Phase 7 CAN start if Phase 6 runs long.
**Why**: The wsutil framework's own unit tests (Phase 5) provide baseline validation. Doc WS provides integration-level validation. Both are useful but only unit tests are strictly required.

### D-P5. Frontend shared WS base ships with DocWsProvider
**Decision**: The shared `WsClient` class is built and validated as part of Phase 8 (Frontend Doc WS), not as a separate phase.
**Why**: The WS client base isn't testable without a backend endpoint. Bundling it with DocWsProvider gives it a real endpoint (Doc WS) for verification.
**Considered**: Separate "WS client base" phase. No verification criteria without a backend endpoint — would just be a code dump.

### D-P6. R5 (ActiveTurnHandle) introduced in Phase 7, not pre-migration
**Decision**: `ActiveTurnHandle` + `ActiveTurnRegistry` interfaces defined in Phase 7 when the first consumer (`TurnStreamHandler`) needs them.
**Why**: Per refactoring proposal recommendation. The interface is simple, the handler is new code. Extract when the first consumer exists — avoids premature abstraction.

### D-P7. ISP split (D31) deferred despite being reviewed
**Decision**: The Handler/StreamHandler ISP split from review decision D31 is NOT implemented in this plan. Doc WS handler implements stub methods returning `ErrNotSupported`.
**Why**: D31 created [#44](https://github.com/haowjy/meridian/issues/44) as a deferred item. The current plan has only 2 handlers. ISP split adds interface complexity without reducing code — each stub is one line. Build it when a third handler type appears.

## Execution-Time Decisions

### D-E1. wsutil binary frame rejection — final-drain in writer loop
**Decision**: Fix race condition where binary frame error envelope is lost due to context cancellation racing with send queue drain. Two changes to `ws.go`: (1) `nextOutbound()` does a final `tryDrainControl()` when `ctx.Done()` is selected, (2) `runWriterLoop()` uses a standalone 2s timeout for writes when the parent context is already cancelled.
**Why**: The read loop enqueues the error via `enqueueControl` (async channel write), then returns, which triggers `c.cancel()` on line 258. Go's select statement randomly picks between `ctx.Done()` and `readyCh` when both are ready — ~50% of the time the writer loop exits without sending the error. The fix ensures control messages are always drained before the writer exits.
**Considered**: (a) Synchronous direct write in the binary frame handler — breaks the single-writer invariant (writer loop owns the WS write path). (b) Delay before `c.cancel()` — fragile timing dependency. (c) Separate close channel from context — too invasive for the fix needed.
**Files**: `backend/internal/wsutil/ws.go` lines 766-777 (writer loop), 797-803 (nextOutbound)
