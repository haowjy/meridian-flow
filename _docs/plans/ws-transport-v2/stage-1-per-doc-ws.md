---
detail: comprehensive
audience: developer
---
# Stage 1: Per-Document WebSocket

**Status:** draft

The largest stage. Replaces the multiplexed per-project WS with per-document connections and a simplified project WS for cross-document events.

**Primary UX motivation:** The current implementation destroys and rebuilds `Y.Doc`, `IndexeddbPersistence`, `CollabSyncRuntime`, and the WS connection on every document switch. This causes visible "Connecting to collaboration..." and "Syncing to collaboration..." spinners every time the writer navigates between chapters. The session manager eliminates this -- warm sessions switch instantly, cold sessions show IndexedDB cached content immediately with background sync. The writer should never see a spinner unless opening a chapter for the first time on that device with no cache.

## Backend Changes

### New: `collab_document_handler.go`

New handler for `GET /ws/documents/{documentId}`.

**Responsibilities:**
- WS upgrade + auth (reuse `collabAuthenticator`)
- Origin validation against `config.CORSOrigins` (allow all in dev) -- fixes Bug #11 immediately
- Acquire document session from `session_manager.Acquire(docID)`
- Run message loop: receive binary, parse 1-byte message-type prefix (see Binary Protocol below), dispatch to session
- Send `{"type":"connected","stateSize":N,"protocol":1}` after auth
- Send SyncStep1 immediately after connected
- Heartbeat (30s interval)
- Rate limiting: carry forward `collabInboundRateLimit = 30` msg/sec from `collab.go`
- Server-side idle timeout: close connection after 5 min of no application messages (only heartbeats)
- On disconnect: `session_manager.Release(docID)` -- this is the ONLY release path (see review finding H-3)

**Binary Protocol (1-byte prefix):**

Follows y-websocket convention. First byte distinguishes message type:

| Prefix | Meaning | Payload |
|--------|---------|---------|
| `0x00` | Sync | Raw Yjs sync protocol bytes (SyncStep1/SyncStep2/Update) |
| `0x01` | Awareness | `encodeAwarenessUpdate(...)` bytes |

This is NOT the old envelope (which was `[1B type][16B docUUID][payload]`). This is a single discriminator byte with no document ID -- the document is implicit from the WS connection.

**What it does NOT do:**
- No envelope framing (no document UUID in frames)
- No subscription management (connect = subscribe)
- No JSON command routing (no `doc:subscribe` / `doc:unsubscribe`)

**Key pattern:** Simpler than current `collab_project.go` because there's no multiplexing logic. The message loop is: receive binary -> parse prefix -> dispatch to single session.

**Server-side connection limit:** Track per-user connection count. Reject with `CONNECTION_LIMIT` error if a user exceeds max 10 concurrent document connections.

**Registration:** `backend/cmd/server/main.go` -- add route alongside existing `/ws/projects/{projectId}`.

### Modify: `collab_project.go` (Simplify)

Strip down to JSON-only project events handler.

**Remove:**
- `handleProjectBinaryMessage()` -- no binary frames on project WS
- `handleDocSubscribe()` / `handleDocUnsubscribe()` -- no subscription protocol
- All envelope framing/unframing calls
- `subscription_service` dependency

**Keep:**
- Auth handshake (`project:connected`)
- Heartbeat
- Rate limiting (JSON messages only now)

**Change: Proposal handling (see S-3 in review-findings.md):**
- Replace `GetSubscription(connectionID, documentID)` with direct `checkDocumentAccess()` call for proposal commands. The subscription check was a proxy for access validation -- in v2, use the authenticator directly.
- Proposals now broadcast to **project WS connections** via a new `ProjectConnectionRegistry` (see below), not the document broadcaster.

**Add:**
- `doc:edited` broadcast when proposals are accepted (see `ws-patterns.md`)
- Origin validation (same as document handler)

### New: `ProjectConnectionRegistry`

New registry for project WS connections. Needed because proposal broadcasts currently go through `InMemoryDocumentBroadcaster` (per-document), but in v2 they must go to project WS connections.

```
type ProjectConnectionRegistry interface {
    Register(projectID, connectionID string, writeChan chan<- []byte)
    Unregister(connectionID string)
    BroadcastToProject(projectID string, message []byte)
}
```

The proposal broadcaster (`collab_proposal_broadcaster.go`) switches from `documentBroadcaster.BroadcastJSON(docID, ...)` to `projectRegistry.BroadcastToProject(projectID, ...)`.

### Remove: Files No Longer Needed

| File | Why |
|------|-----|
| `collab_envelope.go` | No envelope framing in v2 |
| `collab_project_subscription.go` | No subscription management, `multiplexedConnection` eliminated |
| `subscription_service.go` | Multi-doc subscription tracking eliminated |

### Modify: `session_manager.go`

Minimal changes. `Acquire()` / `Release()` stay the same. The caller changes (document handler instead of subscription service), but the session manager doesn't know or care.

Remove any `SubscriptionService` coupling if it exists.

### Modify: `collab_message_loop.go`

Adapt for the simpler per-document case. The loop no longer needs to unwrap envelopes or route by document UUID. It receives raw binary and passes to the single document session.

The project WS gets its own simpler loop (JSON only, no binary).

### Modify: Proposal Broadcasting

`collab_proposal_broadcaster.go` -- proposals broadcast to project WS connections (not document WS). The broadcaster sends JSON events to the project handler's write channel, same as today but without the multiplexed binary layer.

Add: broadcast `{"type":"doc:edited","documentId":"...","source":"proposal_accepted"}` on the project WS when a proposal is accepted.

---

## Frontend Changes

### New: `DocumentSessionManager` (frontend)

`frontend/src/core/cm6-collab/transport/documentSessionManager.ts`

**This is NOT just a WebSocket pool.** It manages full per-document sessions: `Y.Doc` + `IndexeddbPersistence` + WS connection + `CollabSyncRuntime`. Sessions outlive individual component mounts.

> **Why (see review finding S-1):** The current frontend creates and destroys `Y.Doc`, `IndexeddbPersistence`, `CollabSyncRuntime` on every mount/unmount of `useDocumentCollab`. If we only kept the WS alive in a "warm" state, background Yjs updates would have nowhere to land -- no Y.Doc to apply them to. The session manager keeps the full document state alive so warm connections actually receive and apply updates.

```typescript
interface DocumentSessionManager {
  acquire(documentId: string): DocumentSession  // get or create session
  release(documentId: string): void             // move to warm pool (not destroy)
  closeAll(): void
}

interface DocumentSession {
  documentId: string
  yDoc: Y.Doc
  indexeddbProvider: IndexeddbPersistence
  runtime: CollabSyncRuntime
  connection: DocumentConnection    // WS wrapper
  status: 'active' | 'warm' | 'disconnected'
  sendBinary(data: Uint8Array): void
  onStatusChange(handler: (status) => void): Unsubscribe
}
```

**Lifecycle:**
- `acquire()` -- if session exists in warm pool and last heartbeat was within 60s, promote to active (instant, no resync). If session exists in warm pool but last heartbeat was >60s ago (stale), destroy and recreate (cold path). If cold, create new Y.Doc + IndexedDB + WS + runtime.
- `release()` -- move to warm pool. Session stays alive (WS open, Y.Doc in memory, updates applied). Max 3 warm, 5 min timeout, LRU eviction.
- On eviction or timeout -- close WS (which triggers server-side Release), destroy Y.Doc and IndexedDB provider.

**Health check:** If last heartbeat on a warm session was >60s ago, mark as stale. On next `acquire()`, treat as cold (destroy and recreate) rather than promoting a potentially dead session.

**Auth:** Each WS connection sends JWT as first message. Reuse `getAccessToken()` from existing auth.

**Reconnect:** Per-session backoff. One document reconnecting doesn't affect others.

### Modify: `useDocumentCollab.ts`

Replace "create everything on mount, destroy on unmount" with "borrow from session manager."

**Before:**
```
// mount: create Y.Doc, IndexedDB, runtime, subscribe
projectCollab.subscribeDocument(documentId)
// unmount: destroy everything
```

**After:**
```
// mount: borrow existing or create new session
const session = sessionManager.acquire(documentId)
// unmount: release back to warm pool (session stays alive)
sessionManager.release(documentId)
```

**Key changes:**
- No longer creates/destroys `Y.Doc`, `IndexeddbPersistence`, `CollabSyncRuntime` -- session manager owns these
- `sendBinary` callback sends raw Yjs bytes with 1-byte prefix (0x00=sync, 0x01=awareness)
- Cleanup calls `sessionManager.release()` -- session survives in warm pool
- Proposal events still come from `useProjectCollab` via listener registration (unchanged pattern, different transport)

### Modify: `useProjectCollab.ts`

Strip down to project-level concerns.

**Remove:**
- `subscribeDocument()` / `unsubscribeDocument()`
- `sendDocumentBinary()`
- Binary message handling
- `activeSubscriptions` set
- `subscribedDocuments` set
- `replayActiveSubscriptions()`
- Envelope parsing

**Keep:**
- Project WS connection lifecycle
- Auth handshake
- Heartbeat
- All proposal event listeners and routing
- Proposal command sending

**Add:**
- `doc:edited` event handling -> store metadata `{documentId, source, timestamp}` for future UI notifications (anticipatory warmup deferred to later stage)

### Remove: Files No Longer Needed

| File | Why |
|------|-----|
| `envelope.ts` | No envelope framing in v2 |
| `documentSubscriptionDebounce.ts` | Keep-alive pool replaces debounce |

### Modify: `runtime.ts`

Remove envelope wrapping from `sendUpdate`, `sendSyncStep1`, `sendAwareness`. Raw Yjs protocol bytes sent directly via `sendBinary()`.

---

## Migration Strategy

> **Context:** Collab is not deployed to production. It has only been used in dev testing. There are no live users on the old protocol. This means there is no coexistence concern -- we can replace the old implementation wholesale without migration phases.

### Approach: Replace, Don't Migrate

1. Build new backend handlers (`collab_document_handler.go`, `ProjectConnectionRegistry`) alongside old code
2. Build new frontend (`DocumentSessionManager`, updated hooks)
3. Delete old code (envelope, subscription service, multiplexed binary handling)
4. Verify with smoke probes + manual testing

No Phase A/B/C. No feature flags. No mixed-format broadcaster concerns. Just replace and delete.

### Backend Work Order

1. Create `collab_document_handler.go` with per-document WS protocol
2. Create `ProjectConnectionRegistry` for proposal broadcasting
3. Simplify `collab_project.go` (JSON only, proposals via direct auth check)
4. Delete `collab_envelope.go`, `subscription_service.go`, `collab_project_subscription.go`
5. Update `api-events-contract.md` spec

### Frontend Work Order

1. Create `DocumentSessionManager`
2. Modify `useDocumentCollab.ts` to borrow/return sessions
3. Modify `useProjectCollab.ts` to strip binary handling, add `doc:edited` handler
4. Delete `envelope.ts`, `documentSubscriptionDebounce.ts`

---

## Verification

### Smoke Probes (Updated)

| Probe | Changes |
|-------|---------|
| `collab/handshake` | Connect to `/ws/documents/{id}`. No envelope. Auth -> connected -> SyncStep1 sequence. |
| `collab/persistence` | Same protocol changes. Verify content round-trip via per-document WS. |
| `collab/proposals` | Split: proposal events tested via project WS, Yjs sync via document WS. |
| `collab/envelope` | Repurposed: test raw binary handling, oversized rejection (Stage 2). |
| `collab/security` | Auth tests on both WS types. Origin validation included in Stage 1. |
| `collab/multi-doc` | Replaced: rapid connect/disconnect stress test on per-document WS. |

### Manual Tests

1. Open document -> verify sync -> edit -> verify persistence
2. Switch documents -> verify warm pool (switch back within 5 min = instant, no spinners)
3. Switch documents -> wait 5 min -> verify cold open shows IndexedDB cached content instantly
4. Accept proposal on project WS -> verify Yjs update arrives on document WS
5. Close tab -> verify all connections cleaned up (no leaks)

### Automated

- `go vet` on all backend changes
- `pnpm run lint` + `pnpm run build` on frontend
- Existing test suites (vitest, go test)
