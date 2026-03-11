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

(Entries added during implementation below)
