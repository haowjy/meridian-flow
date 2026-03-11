---
detail: standard
audience: developer, architect
---
# ws-transport-v2 Stage 1: Implementation Plan

**Status:** in-progress

## Overview

~4,230 lines across 30 files (20 modified, 4 created, 6 deleted). Split into 5 phases with clear boundaries.

Design docs: `backend-frontend.md` (technical spec), `ws-patterns.md` (protocol), `architecture.md` (diagrams).

## Review Loop

Every phase follows: implement -> fan out reviewers -> synthesize -> fix -> re-review. Phase gate = reviewer consensus + tests pass.

```
coder implements
  |
  v
fan out reviewers (parallel)
  |
  v
orchestrator synthesizes findings
  |-- all clear -> gate check -> next phase
  |-- issues -> coder fixes -> re-review (loop, max 3)
  |-- disagreement -> tiebreak with different model
```

## Phase 0: Foundation (sequential, must complete first)

No transport changes. Fix pre-existing bugs and set up dependencies.

Tasks:
1. **go.mod updates** -- add coder/websocket, promote x/sync and x/time to direct, add goleak (test-only)
2. **Session manager fixes** -- singleflight for Acquire() TOCTOU (Bug #1), refCount guard for ApplyUpdate/GetStateSnapshot (Bug #12)
3. **Error sentinels** -- define ErrAuthFailed, ErrAuthExpired, ErrConnectionLimit, ErrFrameTooLarge in domain package
4. **Authenticator refactor** -- bootstrapAuth returns error not string, add coder/websocket Accept variant

Files: go.mod, session_manager.go, session_manager_test.go, collab_authenticator.go, collab_authenticator_test.go, domain errors file
Est. lines: ~400

Reviewers:
- `reviewer-solid` -- SOLID, code consistency
- `reviewer-concurrency` -- singleflight + refcount race analysis
- `unit-tester` -- verify singleflight + refcount guards with race tests
- `reviewer-planning` -- does Phase 0 set up Phase 1A/1B correctly?
- `documenter -m haiku` then `-m opus` -- update design docs if implementation deviated

## Phase 1A: Document WS Handler (backend, parallelizable with 1B)

New per-document WebSocket endpoint using coder/websocket.

Tasks:
1. **Create collab_document_handler.go** -- websocket.Accept with AcceptOptions, bootstrapAuth, context-based cancellation, 1-byte prefix read loop, heartbeat, idle timeout, connection limit (10 per user), acquire/release session manager
2. **Create collab_document_handler_test.go** -- handshake, sync step1/step2, heartbeat timeout, idle timeout, connection limit, goleak per-test
3. **Register route in main.go** -- GET /ws/documents/{documentId}
4. **Create ProjectConnectionRegistry** -- ProjectBroadcaster + ProjectConnectionRegistrar interfaces, in-memory impl with Send(data) interface (no writeChan)

Files: collab_document_handler.go (new), collab_document_handler_test.go (new), project_connection_registry.go (new), main.go
Est. lines: ~700

Reviewers:
- `reviewer-solid` -- consistency with existing handlers
- `reviewer-concurrency` -- connection lifecycle, goroutine leaks
- `reviewer-security` -- auth, origin, rate limits, frame size
- `unit-tester` -- handler tests: handshake, heartbeat, limits
- `smoke-tester` -- connect to /ws/documents/{id}, bad auth, oversized frames
- `reviewer-planning` -- API shape right for Phase 3 frontend?
- `documenter -m opus` -- update feature docs, API contract

## Phase 1B: Project WS Simplification (backend, parallelizable with 1A)

Strip binary/subscription handling from project WS. It becomes JSON-only. Runs in parallel with 1A via git worktree.

Tasks:
1. **Simplify collab_project.go** -- remove handleProjectBinaryMessage, handleDocSubscribe, handleDocUnsubscribe, subscription validation; keep auth, heartbeat, proposal routing; add doc:edited event handler
2. **Update collab_message_loop.go** -- project WS loop is JSON-only (text messages only)
3. **Update collab_proposal_broadcaster.go** -- JSON events (proposal:*, doc:edited) go through ProjectBroadcaster.BroadcastToProject
4. **Update collab_proposal.go** -- broadcastProposalMutations splits: Yjs binary updates through session manager ApplyUpdate, JSON events through project broadcaster

Files: collab_project.go, collab_message_loop.go, collab_proposal_broadcaster.go, collab_proposal.go, collab_project_test.go, collab_proposal_test.go
Est. lines: ~800 (mix of additions and large deletions)

Reviewers:
- `reviewer-solid` -- clean separation of JSON vs binary paths
- `reviewer-concurrency` -- broadcast fanout, connection registry
- `unit-tester` -- proposal routing tests, verify binary rejection
- `reviewer-planning` -- proposal flow intact for existing frontend?
- `documenter -m opus` -- update proposal event docs

## Phase 2: Cleanup (sequential, after 1A+1B merge)

Delete dead code, update domain interfaces.

Tasks:
1. **Delete files** -- collab_envelope.go, collab_project_subscription.go, subscription_service.go, subscription_service_test.go
2. **Clean up collab.go** -- remove websocketDocumentConnection, bespoke rate tracker, old imports
3. **Update domain interfaces** -- remove/update DocumentBroadcaster, add ProjectBroadcaster
4. **Update collab_test.go** -- rewrite for new patterns

Files: ~10 files (6 deleted, 4 modified)
Est. lines: ~500 deleted, ~200 modified

Reviewers:
- `reviewer-solid` -- dead code, unused imports, interface hygiene

## Phase 3: Frontend (after Phase 1A backend API is stable)

New DocumentSessionManager, simplified hooks, deleted envelope code.

Tasks:
1. **Create DocumentSessionManager** -- singleton, warm pool with LRU, leaseGeneration, pagehide/beforeunload cleanup, acquire/release API, onStatusChange callbacks
2. **Modify runtime.ts** -- remove envelope wrapping, raw Yjs bytes with 1-byte prefix
3. **Modify useDocumentCollab.ts** -- replace Y.Doc/IDB/runtime creation with sessionManager.acquire/release
4. **Modify useProjectCollab.ts** -- remove subscribeDocument, unsubscribeDocument, sendDocumentBinary, envelope parsing, binary handling; add doc:edited handler
5. **Delete files** -- envelope.ts, documentSubscriptionDebounce.ts
6. **Update ProjectCollabContext.tsx** -- provide DocumentSessionManager via context
7. **Update useCollabStore.ts** -- connection status from session manager

Files: 1 new, 5 modified, 2 deleted
Est. lines: ~1000

Reviewers:
- `reviewer-solid` -- React/TS patterns, store consistency
- `reviewer-concurrency` -- async interleaving, warm pool lifecycle
- `smoke-tester` -- open document in browser, test warm pool transitions
- `reviewer-planning` -- does the frontend match the backend API?
- `documenter -m opus` -- final doc sweep

## Dependency Graph

```
Phase 0 (foundation)
  |
  +---> Phase 1A (document WS)  ----+
  |                                  |
  +---> Phase 1B (project WS)  ----+--> Phase 2 (cleanup) --> Phase 3 (frontend)
```

Phase 3 can start after Phase 1A is merged (needs stable API), but Phase 2 cleanup should land first for a clean base.

## Total Estimates

| Phase | Est. Lines | Parallelizable |
|-------|-----------|----------------|
| Phase 0 | ~400 | No (sequential) |
| Phase 1A | ~700 | Yes (with 1B) |
| Phase 1B | ~800 | Yes (with 1A) |
| Phase 2 | ~300 net | No (after 1A+1B) |
| Phase 3 | ~1000 | After 1A stable |
| **Total** | ~3200 net | |

## Parallel Strategy

Phases 1A and 1B run in parallel using git worktrees. Both branch from the Phase 0 commit, merge before Phase 2.

Within a single worktree, work is sequential (one implementer at a time). Reviewers are read-only and can fan out in parallel.
