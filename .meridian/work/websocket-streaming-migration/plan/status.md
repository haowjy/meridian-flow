# WebSocket Streaming Migration — Execution Status

## Phase Tracker

| Phase | Name | Status | Round | Assignee | Notes |
|-------|------|--------|-------|----------|-------|
| 1 | InterjectionRouter Interface | done | 1 | p715 | R4+R10 |
| 2 | Service Layer Hardening | in_progress | 2 | coder | R6+R9+R7+Forwarder |
| 3 | Auth Consolidation | done | 1 | p716 | R1+R3 |
| 4 | mstream Library Fixes | done | 1 | p717 | C1,H1-H7 |
| 5 | wsutil Framework | done | 1 | p718 | 3 files |
| 6 | Doc WS Handler | in_progress | 2 | coder | handler+DocNotifier |
| 7 | Thread WS Handler | not_started | 3 | — | largest phase |
| 8 | Frontend WS Base + DocWsProvider | not_started | 3 | — | shared base |
| 9 | Frontend ThreadWsProvider | not_started | 4 | — | streaming client |
| 10 | SSE + Legacy Cleanup | not_started | 5 | — | deletion phase |

## Round Status

| Round | Phases | Status | Blocked By |
|-------|--------|--------|-----------|
| 1 | 1, 3, 4, 5 | done | — |
| 2 | 2, 6 | in_progress | — |
| 3 | 7, 8 | not_started | Round 2 |
| 4 | 9 | not_started | Round 3 |
| 5 | 10 | not_started | Round 4 |

## Critical Path

Phase 1 → Phase 2 → Phase 7 → Phase 9 → Phase 10 (5 sequential phases)

Alternative path through framework: Phase 5 → Phase 6 → Phase 8 → Phase 9 → Phase 10 (also 5 sequential)

Both paths converge at Phase 9. The thread path is likely longer because Phase 7 (Thread WS) is the largest phase.

## Risk Assessment

| Phase | Risk | Reason |
|-------|------|--------|
| 5 (wsutil) | High | New package with concurrency (scheduler, connection map, heartbeat). Infrastructure everything builds on. |
| 7 (Thread WS) | High | Bridges wsutil + mstream + streaming service. OnSubscribe is the most complex operation. |
| 2 (Service Hardening) | Medium-High | Touches 14+ files. InterjectionForwarder state machine must be provably correct. |
| 4 (mstream) | Medium | SubscribeWithCatchup atomicity is concurrency-sensitive. |
| 9 (Frontend Thread) | Medium | StreamingChannelClient gap recovery + reconnection re-subscribe. |
| 1, 3, 6, 8, 10 | Low-Medium | Mechanical extractions, simple handlers, or deletion. |

## Decisions During Execution

Execution-time pivots recorded in [../decisions.md](../decisions.md).
