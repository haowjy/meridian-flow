---
detail: standard
audience: developer, architect
---
# WebSocket Transport v2: Per-Document Connections

**Status:** in-progress

## Why

Phase 4.6 moved from per-document WS to per-project WS with multiplexed document subscriptions. In practice, the multiplexing layer causes more problems than it solves:

| Problem | Root Cause | Impact |
|---------|-----------|--------|
| Sync responses misrouted between documents (Bug #10) | Envelope-based doc routing is complex and has subtle ordering issues | Data corruption risk |
| Oversized frames kill the entire connection (Bug #9) | One bad frame on the shared pipe tears down all document sessions | Reliability |
| No Origin validation (Bug #11) | Upgrader accepts any origin | Security |
| Head-of-line blocking | Large SyncStep2 for doc A blocks frames for doc B | Latency |
| 64KB too small for legitimate payloads | No HTTP fallback for large state | Functionality gap |

The frontend only has **one active document at a time**. Writers typically work in 1-3 documents per session. The multiplexing was designed for a future multi-doc UI that doesn't exist and may never exist.

**Real-world context:** y-websocket and Liveblocks use per-document/per-room connections. Hocuspocus v2 added multiplexing for multi-user multi-doc scenarios. Meridian is **single-user-first with one active document at a time** -- multiplexing adds complexity with no benefit for this product shape. Per-document connections align with Meridian's architecture and eliminate the routing layer that caused Bug #10.

## Implementation Stages

```mermaid
flowchart TD
    S1["Stage 1<br/>Per-Document WS + Origin Fix<br/>(backend + frontend)"] --> S2["Stage 2<br/>Graceful Oversized<br/>Handling"]
    S1 --> S3["Stage 3<br/>HTTP Bootstrap<br/>(two-lane)"]
    S2 -.-> S3
```

| Stage | What | Fixes | Key Files |
|-------|------|-------|-----------|
| 1 | Per-document WS (`coder/websocket`) + simplified project WS + session manager + origin validation. Old `golang.org/x/net/websocket` code deleted. | Bug #10 (eliminated), Bug #11 (origin), Acquire() TOCTOU race | See `spec/backend-frontend.md` |
| 2 | Application-level size check, structured rejection | Bug #9 | `collab_document_handler.go`, `collab.go` |
| 3 | `GET /api/documents/{id}/yjs-state` + client two-lane decision | Large doc bootstrap | New `collab_state.go`, `httpBootstrap.ts` |

Stage 1 is the foundation. Stages 2-3 are independent after Stage 1.

**Note:** Chat stream delta piggybacking (described in `spec/ws-patterns.md`) is deferred to a future stage. The `applyExternalUpdate(docId, delta)` API is a placeholder in the session manager interface -- Stage 1 does not implement or wire it. It exists as a design marker for the future chat delta integration.

## Relationship to Existing Plans

- **Supersedes Phase 4.6** (`phase/phase-4.6-project-ws-overhaul.md`) -- reverts the per-project multiplexing
- **Updates `spec/api-events-contract.md`** -- new protocol (no envelope, no doc:subscribe)
- **Proposal events stay on project WS** -- `proposal:*` contract unchanged, just different transport
- **Session manager API stable, minor internal cleanup** -- `Acquire(docID)` / `Release(docID)` API unchanged; remove `SubscriptionService` coupling
- **Authenticator reused** -- JWT validation shared by both WS types

## Doc Index

### Spec
| Doc | Purpose |
|-----|---------|
| `spec/plan.md` | Stage 1 phases, tasks, dependency graph, estimates |
| `spec/backend-frontend.md` | Stage 1 technical spec (backend + frontend changes) |
| `spec/ws-patterns.md` | Protocol specs, session manager, chat delta piggybacking, CRDT guarantee |
| `spec/ui-requirements.md` | What the UI must handle from the transport layer |
| `spec/architecture.md` | Target architecture diagrams |
| `spec/agent-headcount.md` | Per-phase agent staffing and orchestration workflow |

### Reference
| Doc | Purpose |
|-----|---------|
| `reference/known-bugs.md` | Bugs being fixed + real-world Yjs pitfalls |
| `reference/whats-weird.md` | Surprising patterns implementers should know |

### Tracking
| Doc | Purpose |
|-----|---------|
| `tracking/log.md` | Decisions + implementation findings (append-only) |

### Archive
| Doc | Purpose |
|-----|---------|
| `_archive/review-findings.md` | Adversarial review findings (rounds 1-4, all resolved) |
