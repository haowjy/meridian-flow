# WebSocket Streaming Migration — Execution Status

## Phase Tracker

| Phase | Name | Status | Round | Assignee | Notes |
|-------|------|--------|-------|----------|-------|
| 1 | InterjectionRouter Interface | done | 1 | p715 | R4+R10 |
| 2 | Service Layer Hardening | done | 2 | p719 | R6+R9+R7+Forwarder |
| 3 | Auth Consolidation | done | 1 | p716 | R1+R3 |
| 4 | mstream Library Fixes | done | 1 | p717 | C1,H1-H7 |
| 5 | wsutil Framework | done | 1 | p718 | 3 files |
| 6 | Doc WS Handler | done | 2 | p720 | handler+DocNotifier |
| 7 | Thread WS Handler | done | 3 | p721 | largest phase |
| 8 | Frontend WS Base + DocWsProvider | done | 3 | p722 | shared base |
| 9 | Frontend ThreadWsProvider | done | 4 | p723 | streaming client |
| 10 | SSE + Legacy Cleanup | done | 5 | p724 | deletion phase + wsutil race fix |
| 11 | Doc Handler Yjs Stream Support | done | 6 | p732 | handler upgrade + interface migration |
| 12 | Frontend DocStreamClient + Provider Rewrite | done | 7 | p738 | new client + rewrite + session wiring + review fixes |
| 13 | Per-Document Yjs WS Removal | in-progress | 8 | — | deletion phase |

## Round Status

| Round | Phases | Status | Blocked By |
|-------|--------|--------|-----------|
| 1 | 1, 3, 4, 5 | done | — |
| 2 | 2, 6 | done | — |
| 3 | 7, 8 | done | — |
| 4 | 9 | done | — |
| 5 | 10 | done | — |
| 6 | 11 | done | — |
| 7 | 12 | done | Round 6 |
| 8 | 13 | in-progress | Round 7 |

## Critical Path

Phase 1 → Phase 2 → Phase 7 → Phase 9 → Phase 10 → Phase 11 → Phase 12 → Phase 13

Rounds 6-8 are strictly sequential — no parallelism available.

## Risk Assessment

| Phase | Risk | Reason |
|-------|------|--------|
| 5 (wsutil) | High | New package with concurrency (scheduler, connection map, heartbeat). Infrastructure everything builds on. |
| 7 (Thread WS) | High | Bridges wsutil + mstream + streaming service. OnSubscribe is the most complex operation. |
| 2 (Service Hardening) | Medium-High | Touches 14+ files. InterjectionForwarder state machine must be provably correct. |
| 11 (Doc Handler Yjs) | Medium-High | Cross-connection registry concurrency, deferred release guard, multiple interface migrations. |
| 12 (Frontend DocStream) | Medium | New client class, session injection wiring, provider rewrite. |
| 4 (mstream) | Medium | SubscribeWithCatchup atomicity is concurrency-sensitive. |
| 9 (Frontend Thread) | Medium | StreamingChannelClient gap recovery + reconnection re-subscribe. |
| 1, 3, 6, 8, 13 | Low-Medium | Mechanical extractions, simple handlers, or deletion. |

## Decisions During Execution

Execution-time pivots recorded in [../decisions.md](../decisions.md).
