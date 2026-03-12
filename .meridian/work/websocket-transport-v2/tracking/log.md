---
detail: standard
audience: developer, architect
---
# ws-transport-v2: Tracking Log

## Decisions

Tracks implementation decisions as they come up. Each entry is immutable once written -- add new entries, do not modify old ones.

### Format

Each decision:
- **ID**: D-{number}
- **Date**: YYYY-MM-DD
- **Context**: What question came up
- **Decision**: What we decided
- **Rationale**: Why
- **Alternatives considered**: What else we thought about
- **Decided by**: Who made the call

### D-1: WebSocket Library Choice
- **Date:** 2026-03-10
- **Context:** Which Go WebSocket library to use for v2
- **Decision:** coder/websocket (github.com/coder/websocket)
- **Rationale:** Context-native API, concurrent-write-safe, actively maintained by Coder Inc. Modern patterns less likely to break.
- **Alternatives:** gorilla/websocket (more stars but maintenance mode, old patterns), gobwas/ws (low-level, graceful reject), gws (performance-focused), nbio (event-driven)
- **Decided by:** User

### D-2: Oversized Frame Strategy
- **Date:** 2026-03-10
- **Context:** Accept oversized WS frames and break them down, or reject/close?
- **Decision:** Close connection on oversized frames (>256KB)
- **Rationale:** Stage 3 HTTP bootstrap handles large payloads. No legitimate >256KB WS frames after initial sync. Closing is simpler and safer.
- **Alternatives:** Graceful reject-and-continue (would need gobwas/ws), frame splitting
- **Decided by:** User + orchestrator

### D-3: Supporting Libraries
- **Date:** 2026-03-10
- **Context:** What supporting libraries alongside coder/websocket
- **Decision:** golang.org/x/sync/singleflight, golang.org/x/time/rate, go.uber.org/goleak
- **Rationale:** All stdlib/standard ecosystem. singleflight for TOCTOU, rate for rate limiting, goleak for test-only leak detection.
- **Decided by:** Orchestrator (user approved)

### D-4: Migration Strategy
- **Date:** 2026-03-10
- **Context:** Feature flag / gradual rollout or hard cutover?
- **Decision:** Hard cutover only
- **Rationale:** No real users. No need for backwards compatibility or gradual migration.
- **Decided by:** Orchestrator

---

(New decisions added below as implementation proceeds)

## Implementation Log

Append-only log of decisions, weird findings, and backlog items discovered during implementation. The orchestrator (Claude Opus primary) writes entries here as reports come back from spawned agents.

### Format

Each entry:
- **ID**: IL-{number}
- **Phase**: which phase
- **Category**: decision | weird | backlog | bug
- **Description**: what happened
- **Resolution**: what we did about it (or "deferred")

### Log

#### IL-1
- **Phase:** 0
- **Category:** decision
- **Description:** Spawned agents report exit 143 (SIGTERM from codex harness) but complete their work and produce correct output. Treating these as successful completions since go vet + go test pass.
- **Resolution:** Accepted; verified all output manually.

#### IL-2
- **Phase:** 0
- **Category:** decision
- **Description:** singleflight Acquire keeps a post-singleflight lock re-check (existing session check) even though singleflight should prevent duplicates. This is belt-and-suspenders since singleflight. Do results are shared by reference -- a second caller could race into the map insertion.
- **Resolution:** Kept the re-check as defensive programming.

#### IL-3
- **Phase:** 0
- **Category:** decision
- **Description:** releaseSessionRef extracted as shared helper for ApplyUpdate/GetStateSnapshot temporary refCount pin cleanup. Same logic as Release() but callable with a specific session reference.
- **Resolution:** Accepted; reduces duplication between Release() and operational ref releases.

#### IL-4
- **Phase:** 1B
- **Category:** decision
- **Description:** Phase 1B review (p61/p62/p63) flagged per-connection document access cache as stale-authorization risk (HIGH by reviewer-solid). The cache never revalidates during connection lifetime.
- **Resolution:** Accepted as deliberate design. The old subscription model had identical behavior (once subscribed, stayed subscribed until disconnect). Connection lifetimes are short (page session). Revalidation hooks add complexity with no current use case.

#### IL-5
- **Phase:** 1B
- **Category:** bug
- **Description:** Both reviewer-solid and reviewer-concurrency flagged BroadcastToProject holding RLock during network I/O (Send calls). Slow/broken clients can block Register/Unregister, causing contention.
- **Resolution:** Fix spawned (p64): snapshot connections under lock, release, send outside lock. Same pattern as BroadcastToDocument.

#### IL-6
- **Phase:** 1B
- **Category:** decision
- **Description:** reviewer-planning flagged missing doc:edited event (in plan.md as Phase 1B task) and broken frontend proposal compatibility (frontend gates on doc:subscribed which was removed).
- **Resolution:** Accepted. Working on h/collab feature branch — all phases land atomically before merge to main. Frontend compatibility handled in Phase 3. doc:edited deferred since it's new functionality, not a regression.

#### IL-7
- **Phase:** 1B
- **Category:** backlog
- **Description:** reviewer-solid flagged concrete *CollabDocumentHandler dependency where a narrow interface would suffice (DIP violation).
- **Resolution:** Deferred to Phase 2 cleanup — introduce DocumentBroadcaster interface.

#### IL-8
- **Phase:** 1B
- **Category:** backlog
- **Description:** Dead code: getSubscriptionInvalidationReason in collab_authenticator.go no longer used at runtime.
- **Resolution:** Deferred to Phase 2 cleanup.

#### IL-9
- **Phase:** 2
- **Category:** decision
- **Description:** Phase 2 reviewer-solid approved cleanup. No issues found — all dead code removed cleanly, DocumentBroadcaster interface well-placed.
- **Resolution:** Approved, no changes needed.

#### IL-10
- **Phase:** 3
- **Category:** bug
- **Description:** Phase 3 reviewer-solid flagged CollabSyncRuntime's didStartSync guard is one-shot — on reconnect, runtime stays stuck in syncing state.
- **Resolution:** Fixed: added reset() method to CollabSyncRuntime, called from DocumentSessionManager on reconnect.

#### IL-11
- **Phase:** 3
- **Category:** bug
- **Description:** All three Phase 3 reviewers flagged AUTH_EXPIRED not handled for token refresh in frontend project WS transport.
- **Resolution:** Fixed: added AUTH_EXPIRED to same refresh condition as AUTH_FAILED in useProjectCollab.ts.

#### IL-12
- **Phase:** 3
- **Category:** bug
- **Description:** reviewer-planning flagged doc:error events not routed to document listeners in project WS transport.
- **Resolution:** Fixed: added doc:error routing in useProjectCollab.ts handleTextMessage.

#### IL-13
- **Phase:** 3
- **Category:** backlog
- **Description:** Proposal snapshot bootstrap gap — backend no longer sends proposal:snapshot (was part of removed doc:subscribe handshake). Proposals won't appear until a mutation event occurs.
- **Resolution:** Deferred — requires new proposal:getSnapshot command. Will be separate work item.

#### IL-14
- **Phase:** 3
- **Category:** backlog
- **Description:** Stale connect() race in useProjectCollab.ts — no generation/cancel token, StrictMode double-mount can create parallel sockets.
- **Resolution:** Pre-existing issue, not a Phase 3 regression. Noted for future hardening.

#### IL-15
- **Phase:** 3
- **Category:** backlog
- **Description:** Warm pool not implemented in DocumentSessionManager — release immediately destroys sessions.
- **Resolution:** Intentionally deferred per Phase 3 prompt. Future optimization.

#### IL-16
- **Phase:** 3
- **Category:** decision
- **Description:** doc:edited event not implemented (was in plan.md as Phase 1B task).
- **Resolution:** Deferred — new functionality, not a regression. Will be separate work item.

#### IL-17
- **Phase:** 3
- **Category:** bug
- **Description:** DocumentSessionManager throws "is destroyed" on mount due to React StrictMode double-mount. useMemo creates one instance, useEffect cleanup destroys it, StrictMode re-mount tries to acquire on the destroyed instance.
- **Resolution:** Fixed: added revive() method, called in useEffect setup in ProjectCollabContext.tsx.

#### IL-18
- **Phase:** review
- **Category:** backlog
- **Description:** Reconnect backoff resets too early — both DocumentSessionManager and useProjectCollab zero reconnectAttempt on socket open, before auth succeeds. Bad token causes infinite fast retries.
- **Resolution:** Deferred. Reset should happen after connected/project:connected, not on socket open.

#### IL-19
- **Phase:** review
- **Category:** backlog
- **Description:** Document handler uses HTTP request context after websocket.Accept. Should detach from request context and manage cancellation from socket lifecycle.
- **Resolution:** Deferred.

#### IL-20
- **Phase:** review
- **Category:** backlog
- **Description:** Duplicate normalizeDocumentId() and normalizeAPIBase() in DocumentSessionManager.ts and useProjectCollab.ts. Extract to shared utility.
- **Resolution:** Deferred to frontend rewrite.

#### IL-21
- **Phase:** review
- **Category:** backlog
- **Description:** pagehide/beforeunload handler missing — tab close leaves server waiting for heartbeat timeout (~35s). Add alongside warm pool.
- **Resolution:** Deferred.

#### IL-22
- **Phase:** review
- **Category:** bug
- **Description:** Group proposal accept applies Yjs updates sequentially to a mutating doc. Each update was built against the original state, but the 2nd+ update's positions are stale. Causes truncation when accepting multiple proposals.
- **Resolution:** Fixed. GroupAccept now composes all proposal Yjs updates into a single composite update via a temp Y.Doc (mirrors buildProjectedDoc pattern) before applying once to the live runtime. Added GetCurrentState to ProposalRuntime interface. 5 new composition tests.
