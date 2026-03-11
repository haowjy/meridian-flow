---
detail: standard
audience: developer, architect
---
# ws-transport-v2 Stage 1: Implementation Plan

**Status:** complete

## Overview

Split into 5 phases. All phases implemented and reviewed. See `tracking/log.md` for implementation decisions and deferred items.

Design docs: `backend-frontend.md` (technical spec), `ws-patterns.md` (protocol), `architecture.md` (diagrams).

## Review Loop

Every phase followed: implement -> fan out reviewers -> synthesize -> fix -> re-review. Phase gate = reviewer consensus + tests pass.

## Phases

| Phase | Scope | Status | Notes |
|-------|-------|--------|-------|
| 0 | Foundation: singleflight, refCount guards, error sentinels, authenticator refactor | Complete | |
| 1A | Document WS handler (`coder/websocket`), ProjectConnectionRegistry | Complete | |
| 1B | Project WS simplification (JSON-only, direct access checks) | Complete | |
| 2 | Dead code cleanup, DocumentBroadcaster interface | Complete | |
| 3 | Frontend: DocumentSessionManager, runtime de-enveloping, hook rewrites | Complete | |

## Deferred Items

Discovered during implementation. See `tracking/log.md` for full context.

| Item | Log ID | Reason |
|------|--------|--------|
| Warm pool (frontend session keep-alive) | IL-15 | Intentionally deferred; release immediately destroys sessions |
| `doc:edited` event broadcast | IL-16 | New functionality, not a regression |
| `proposal:snapshot` bootstrap on project WS connect | IL-13 | Requires new `proposal:getSnapshot` command; proposals appear only after mutation events |
| Stale `connect()` race in useProjectCollab | IL-14 | Pre-existing, not a Phase 3 regression |

## Dependency Graph

```
Phase 0 (foundation)
  |
  +---> Phase 1A (document WS)  ----+
  |                                  |
  +---> Phase 1B (project WS)  ----+--> Phase 2 (cleanup) --> Phase 3 (frontend)
```
