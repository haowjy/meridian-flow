# Phase 4.6: Per-Project WebSocket Overhaul

## Context

Phases 1–4.5 used a per-document WebSocket (`/ws/documents/{docId}`). Every document switch = close WS + JWT re-auth + Yjs sync handshake. This phase migrates to a single per-project WebSocket with dynamic document subscription.

## Architecture: Before → After

```
BEFORE:
  Browser ──WS /ws/documents/{docA}──> Go Backend (1 WS per document)
  Switch doc → close WS → open new WS → re-auth → re-sync

AFTER:
  Browser ──WS /ws/projects/{projectId}──> Go Backend (1 WS per project)
  Switch doc → send doc:subscribe → sync (no reconnect)
```

## Protocol

### Binary frames (document-multiplexed)

`[1B envelope][16B docID (UUID binary, big-endian)][N bytes Yjs payload]`

Envelope types: 0x00=sync1, 0x01=sync2, 0x02=update, 0x03=awareness

> **Head-of-line blocking:** WebSocket is sequential — a large SyncStep2 for document A blocks delivery of frames for document B. Low risk for text documents (small updates). Future: chunk SyncStep2 > 100KB if latency becomes noticeable.

### Subscribe/Unsubscribe

```
Client sends:  { "type": "doc:subscribe", "documentId": "..." }
Server does:   VerifyOwnership → VerifyProjectMatch → Acquire → Subscribe
Server sends:  sync-step1 frame (multiplexed binary)
Server sends:  proposal:snapshot (JSON with documentId)
Server sends:  { "type": "doc:subscribed", "documentId": "..." }
Client does:   On receiving "doc:subscribed" → runtime.startSync()
```

`doc:subscribed` is the LAST message in the subscribe sequence. Client buffers binary frames until then.

### Reconnect

Project hook maintains `activeSubscriptions` set. On reconnect: re-auth → re-subscribe all active documents → re-startSync each.

### Key Design Decisions

- **`multiplexedConnection` adapter** wraps outbound binary frames with docID for broadcaster compatibility. Broadcaster is unchanged — the adapter handles framing transparently via `Connection.Send()`
- **Subscribe is idempotent** — double-subscribe = no-op + re-send `doc:subscribed` (avoids refcount inflation)
- **Project-document consistency** — subscribe checks that the document belongs to the WS project via `DocumentResolver.ResolveDocument`
- **Frontend debounced unsubscribe** — 100ms debounce to handle React StrictMode double-mount
- **All document-scoped JSON events include `documentId`** — `proposal:snapshot`, `proposal:statusChanged`, and `proposal:groupAcceptResult` fixed to add it
- **All document-scoped JSON commands include `documentId`** — `proposal:accept`, `proposal:reject`, `proposal:groupAccept` fixed to include it (previously derived from URL path, which won't exist on project WS)
- **Proposal broadcast uses `mutation.DocumentID`** — authoritative source from ProposalService, not handler parameter
- **Per-document error isolation** — `doc:error` for one document does NOT close the project WebSocket. Only `AUTH_FAILED` closes the entire connection
- **Server-initiated unsubscribe** — if a document is deleted or moved while subscribed, server sends `doc:unsubscribed` with reason and cleans up the subscription
- **Max concurrent subscriptions** — 10 per connection (writers typically have 1-3 documents open)
- **Awareness is per-document** — binary awareness frames include docID in the multiplexed format. Cursor positions only make sense within a document context. No project-wide awareness in Phase 4.6

## Contract Fixes (Pre-Migration)

These are **existing bugs** where `documentId` is missing from events/commands. Currently harmless because 1 WS = 1 document, but breaks with project WS multiplexing. Must be fixed in Slice 1.

| What | Go Location | TS Location | Fix |
|---|---|---|---|
| `proposalStatusChangedEvent` | `collab_proposal.go` `proposalStatusChangedEvent` struct | `contracts.ts` `ProposalStatusChangedEvent` | Add `documentId` field, populate from `mutation.DocumentID` |
| `proposalGroupAcceptResultEvent` | `collab_proposal.go` `proposalGroupAcceptResultEvent` struct | `contracts.ts` `ProposalGroupAcceptResultEvent` | Add `documentId` field |
| `proposalSnapshotEvent` | `collab_proposal.go` `proposalSnapshotEvent` struct | `contracts.ts` `ProposalSnapshotEvent` | Add `documentId` field |
| `proposalAcceptCommand` | `collab_proposal.go` `proposalAcceptCommand` struct | `contracts.ts` `ProposalAcceptCommand` | Add `documentId` field |
| `proposalRejectCommand` | `collab_proposal.go` `proposalRejectCommand` struct | `contracts.ts` `ProposalRejectCommand` | Add `documentId` field |
| `proposalGroupAcceptCommand` | `collab_proposal.go` `proposalGroupAcceptCommand` struct | `contracts.ts` `ProposalGroupAcceptCommand` | Add `documentId` field |
| `broadcastProposalMutations` | `collab_proposal.go:338` | — | Use `mutation.DocumentID` instead of handler `docID` param |

Also update TS type guards in `contracts.ts` (`isProposalStatusChangedEvent`, `isProposalGroupAcceptResultEvent`, etc.) to validate `documentId` presence.

## Sub-Phases

| Phase | Goal | Slices |
|---|---|---|
| 4.6a | Protocol + contract fixes + backend handler | 1–2 |
| 4.6b | Frontend migration + old endpoint removal | 3–5 |
| 4.6c | SRP refactoring + docs | 6–7 |

### Slice Summary

| Slice | Description |
|---|---|
| 1 | Contract fixes: `documentId` on all events/commands (Go + TS) + `mutation.DocumentID` for broadcast + multiplexed frame format |
| 2 | Backend project WS handler (`ConnectProject`, subscribe/unsubscribe, `multiplexedConnection`, max 10 subs) |
| 3 | Frontend `useProjectCollab` hook + React context + reconnect resubscribe |
| 4 | Refactor `useDocumentCollab` to delegate transport + debounced unsubscribe |
| 5 | Remove per-document WS endpoint |
| 6 | Backend SRP refactoring: extract `collabAuthenticator` + shared message-loop core |
| 7 | Documentation updates (phase doc, spec contract, feature docs) |

### Slice 6 Detail: SRP Refactoring

`collab.go` is ~500 lines with 6+ responsibilities (WS upgrade, JWT auth, ownership check, session lifecycle, heartbeat, rate limiting, binary frame dispatch). Both `handleDocumentSocket` and `ConnectProject` need auth and message dispatch, creating duplication risk.

**Extract `collabAuthenticator`:**
- JWT verification + ownership/project-access checks
- Reusable by both document and project handlers
- Source: auth logic from `handleDocumentSocket` lines 182-246

**Extract shared message-loop core:**
- Binary frame dispatch (envelope unwrap → session.HandleSyncPayload → broadcast)
- Rate limiting (`collabInboundRateTracker`)
- Heartbeat integration
- The project handler needs all the same dispatch logic but routes by docID from the multiplexed frame

## Key Files

**Backend (new):**
- `handler/collab_project.go` — project WS handler + `multiplexedConnection` adapter

**Backend (modified):**
- `handler/collab_envelope.go` — multiplexed frame format
- `handler/collab_proposal.go` — `documentId` on events/commands, `mutation.DocumentID` for broadcast
- `handler/collab.go` — shared helpers, `authorizer` field
- `cmd/server/main.go` — route registration

**Frontend (new):**
- `hooks/useProjectCollab.ts` — project WS lifecycle
- `contexts/ProjectCollabContext.ts` — React context

**Frontend (modified):**
- `hooks/useDocumentCollab.ts` — delegate transport, debounced unsubscribe

**CM6:**
- `packages/cm6-collab/src/sync/envelope.ts` — multiplexed frame format (TS side)
- `packages/cm6-collab/src/proposals/contracts.ts` — `documentId` on all events

## Status: PLANNED
