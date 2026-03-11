---
detail: standard
audience: developer, architect
---
# ws-transport-v2 Stage 1: Implementation Plan

**Status:** draft

## Overview

~4,230 lines across 30 files (20 modified, 4 created, 6 deleted). Split into 5 phases with clear boundaries.

## Phase Order

### Phase 0: Foundation (sequential, must complete first)

No transport changes. Fix pre-existing bugs and set up dependencies.

Tasks:
1. **go.mod updates** -- add coder/websocket, promote x/sync and x/time to direct, add goleak (test-only)
2. **Session manager fixes** -- singleflight for Acquire() TOCTOU (Bug #1), refCount guard for ApplyUpdate/GetStateSnapshot (Bug #12)
3. **Error sentinels** -- define ErrAuthFailed, ErrAuthExpired, ErrConnectionLimit, ErrFrameTooLarge in domain package
4. **Authenticator refactor** -- bootstrapAuth returns error not string, add coder/websocket Accept variant

Files: go.mod, session_manager.go, session_manager_test.go, collab_authenticator.go, collab_authenticator_test.go, domain errors file
Est. lines: ~400
Gate: all existing tests pass + new singleflight/refcount tests pass

### Phase 1A: Document WS Handler (backend, parallelizable with 1B)

New per-document WebSocket endpoint using coder/websocket.

Tasks:
1. **Create collab_document_handler.go** -- websocket.Accept with AcceptOptions, bootstrapAuth, context-based cancellation, 1-byte prefix read loop, heartbeat, idle timeout, connection limit (10 per user), acquire/release session manager
2. **Create collab_document_handler_test.go** -- handshake, sync step1/step2, heartbeat timeout, idle timeout, connection limit, goleak per-test
3. **Register route in main.go** -- GET /ws/documents/{documentId}
4. **Create ProjectConnectionRegistry** -- ProjectBroadcaster + ProjectConnectionRegistrar interfaces, in-memory impl with Send(data) interface (no writeChan)

Files: collab_document_handler.go (new), collab_document_handler_test.go (new), project_connection_registry.go (new), main.go
Est. lines: ~700
Gate: can connect to /ws/documents/{id}, complete Yjs handshake, sync updates between 2 clients

### Phase 1B: Project WS Simplification (backend, parallelizable with 1A)

Strip binary/subscription handling from project WS. It becomes JSON-only.

Tasks:
1. **Simplify collab_project.go** -- remove handleProjectBinaryMessage, handleDocSubscribe, handleDocUnsubscribe, subscription validation; keep auth, heartbeat, proposal routing; add doc:edited event handler
2. **Update collab_message_loop.go** -- project WS loop is JSON-only (text messages only)
3. **Update collab_proposal_broadcaster.go** -- JSON events (proposal:*, doc:edited) go through ProjectBroadcaster.BroadcastToProject
4. **Update collab_proposal.go** -- broadcastProposalMutations splits: Yjs binary updates through session manager ApplyUpdate, JSON events through project broadcaster

Files: collab_project.go, collab_message_loop.go, collab_proposal_broadcaster.go, collab_proposal.go, collab_project_test.go, collab_proposal_test.go
Est. lines: ~800 (mix of additions and large deletions)
Gate: project WS handles proposals correctly, no binary messages accepted

### Phase 2: Cleanup (sequential, after 1A+1B merge)

Delete dead code, update domain interfaces.

Tasks:
1. **Delete files** -- collab_envelope.go, collab_project_subscription.go, subscription_service.go, subscription_service_test.go
2. **Clean up collab.go** -- remove websocketDocumentConnection, bespoke rate tracker, old imports
3. **Update domain interfaces** -- remove/update DocumentBroadcaster, add ProjectBroadcaster
4. **Update collab_test.go** -- rewrite for new patterns

Files: ~10 files (6 deleted, 4 modified)
Est. lines: ~500 deleted, ~200 modified
Gate: build passes, all tests pass, no dead code references

### Phase 3: Frontend (after Phase 1A backend API is stable)

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
Gate: pnpm build passes, pnpm lint passes, can open document and see collab sync working

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
