---
detail: comprehensive
audience: developer
---
# Stage 1: Per-Document WebSocket

**Status:** draft

The largest stage. Replaces the multiplexed per-project WS with per-document connections and a simplified project WS for cross-document events.

**Primary UX motivation:** The current implementation destroys and rebuilds `Y.Doc`, `IndexeddbPersistence`, `CollabSyncRuntime`, and the WS connection on every document switch. This causes visible "Connecting to collaboration..." and "Syncing to collaboration..." spinners every time the writer navigates between chapters. The session manager eliminates this -- warm sessions switch instantly, cold sessions show IndexedDB cached content immediately with background sync. The writer should never see a spinner unless opening a chapter for the first time on that device with no cache.

## Backend Changes

### Dependencies (New or Updated)

| Package | Purpose | Notes |
|---------|---------|-------|
| `github.com/coder/websocket` | WS library for new handlers | Context-native API, concurrent-write-safe, actively maintained by Coder Inc. Old `golang.org/x/net/websocket` code is deleted with old handlers. |
| `golang.org/x/sync/singleflight` | Fix Acquire() TOCTOU race in session manager | See session_manager.go changes below |
| `golang.org/x/time/rate` | Inbound rate limiting for document handler | Replaces bespoke rate tracker |
| `go.uber.org/goleak` | Test-only goroutine leak detection | Verify no leaked goroutines after connect/disconnect cycles |

### New: `collab_document_handler.go`

New handler for `GET /ws/documents/{documentId}`. Uses `coder/websocket` (not the old `golang.org/x/net/websocket` library).

**Responsibilities:**
- WS upgrade + auth (reuse `collabAuthenticator`)
- Origin validation against `config.CORSOrigins` (allow all in dev) -- fixes Bug #11 immediately
- Acquire document session from `session_manager.Acquire(docID)`
- Run message loop: receive binary, parse 1-byte message-type prefix (see Binary Protocol below), dispatch to session
- Send `{"type":"connected","stateSize":N,"protocol":1}` after auth
- Send SyncStep1 immediately after connected
- Heartbeat (30s interval)
- Rate limiting: one `rate.Limiter` per connection, created at connection setup. Carries forward `collabInboundRateLimit = 30` msg/sec from `collab.go`
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
- Cache `documentId -> projectId` mapping per-connection at first use. Implementation: simple `map[string]string` guarded by a connection-scoped `sync.Mutex`. Subsequent proposal commands for the same document verify against the cached project binding without hitting the DB. Cache lives for the connection lifetime. Staleness is acceptable -- project WS reconnect resets it. No explicit invalidation needed.
- Proposals now broadcast to **project WS connections** via a new `ProjectConnectionRegistry` (see below), not the document broadcaster.

**Add:**
- `doc:edited` broadcast when proposals are accepted (see `ws-patterns.md`)
- Origin validation (same as document handler)

### New: `ProjectConnectionRegistry`

New registry for project WS connections. Needed because proposal broadcasts currently go through `InMemoryDocumentBroadcaster` (per-document), but in v2 they must go to project WS connections.

**Interface split (ISP):** Split into two interfaces consumed by different callers. A single concrete struct satisfies both.

```
// Consumed by proposal broadcaster
type ProjectBroadcaster interface {
    BroadcastToProject(projectID string, message []byte)
}

// Consumed by project WS handler
type ProjectConnectionRegistrar interface {
    Register(projectID, connectionID string, conn ProjectConnection)
    Unregister(connectionID string)
}

// Connection interface -- no channel, coder/websocket handles write concurrency
type ProjectConnection interface {
    Send(data []byte) error
}
```

**Why no `writeChan`:** `coder/websocket` is concurrent-write-safe. Wrapping writes in a channel adds an unnecessary goroutine per connection. The `Send(data []byte) error` interface lets the concrete implementation call `conn.Write()` directly.

**Handler caches projectId from auth** -- the connection knows its project binding from the initial auth handshake. No registry lookup needed for the handler's own project.

The proposal broadcaster (`collab_proposal_broadcaster.go`) switches from `documentBroadcaster.BroadcastJSON(docID, ...)` to `projectBroadcaster.BroadcastToProject(projectID, ...)`.

### Remove: Files No Longer Needed

| File | Why |
|------|-----|
| `collab_envelope.go` | No envelope framing in v2 |
| `collab_project_subscription.go` | No subscription management, `multiplexedConnection` eliminated |
| `subscription_service.go` | Multi-doc subscription tracking eliminated |

### Modify: `session_manager.go`

Minimal changes. The caller changes (document handler instead of subscription service), but the session manager API stays the same.

Remove any `SubscriptionService` coupling if it exists.

**Fix Acquire() TOCTOU race (CRITICAL, pre-existing bug):** The current `Acquire()` checks existence under lock, then loads state outside lock. Two concurrent callers can both see "not loaded" and create duplicate Y.Docs. Fix using `singleflight`:

1. Under the lock, check if session exists. If so, increment refcount and return.
2. If not, use `singleflight.Group.Do(docID, loadFn)` to ensure exactly one loader runs.
3. `singleflight` eliminates the possibility of a second load entirely -- there is no "loser" to clean up. The second caller blocks on the first caller's result and receives the same session. This is the key insight: singleflight does not race two loaders and pick a winner; it prevents the second load from ever starting.
4. The load function uses a **detached context** (`context.Background()` + timeout), not the request context, so the loader is not cancelled if the triggering request is cancelled (see Context Strategy below).
5. On load completion, insert session into the map under lock.

**Fix ApplyUpdate() use-after-delete race (CRITICAL, pre-existing bug #12):** `ApplyUpdate()` and `GetStateSnapshot()` read the session reference under the manager lock, release the lock, then operate on the session. A concurrent `Release()` can destroy the session between lock release and the operation. Fix: increment `refCount` under the manager lock before calling the operation, decrement after. This prevents `Release()` from destroying the session mid-update.

**Lease generation guard for release/acquire races:** Each session carries a monotonic `leaseGeneration` counter. `release()` captures the current generation when scheduling warm eviction. `acquire()` increments the generation, invalidating any pending eviction timer. The eviction callback only destroys the session if the generation still matches -- this prevents a race where a slow eviction timer fires after a new acquire has already reclaimed the session.

Pseudocode (server-side session_manager.go):

```
acquire(docId):
  lock()
  session = sessions[docId]
  if session != nil:
    session.refCount++
    unlock()
    return session
  unlock()

  // singleflight ensures exactly one load
  result = singleflight.Do(docId, func():
    // detached context -- not tied to request
    ctx = context.Background() + 5s timeout
    session = loadFromDB(ctx, docId)
    lock()
    sessions[docId] = session
    session.refCount = 1
    unlock()
    return session
  )
  return result

release(docId):
  lock()
  session = sessions[docId]
  session.refCount--
  if session.refCount > 0:
    unlock(); return
  // refCount == 0 -- schedule idle timeout (H-5)
  capturedGen = session.leaseGeneration
  unlock()
  setTimeout(IDLE_TIMEOUT, func():
    lock()
    if session.leaseGeneration != capturedGen:
      unlock(); return  // re-acquired since release
    delete(sessions, docId)
    unlock()
    session.destroy()  // outside lock: persist + close
  )
```

**Release() underflow guard:** If `refCount` is already 0 when `Release()` is called, log a warning and return without decrementing. This is a defensive guard against double-release bugs. Architectural invariant: **warm pool eviction must NEVER call Release() directly** -- it closes the WS, which triggers the handler's deferred `Release()`. Calling Release() from eviction AND from the handler defer would double-decrement.

**The server has no warm pool concept.** The server sees open connections and closed connections. The warm pool is purely a client-side abstraction managed by `DocumentSessionManager`. The server-side idle timeout (H-5) is the server-equivalent of warm eviction -- if no application messages arrive for 5 minutes, the server closes the connection.

### Context Strategy

- **singleflight load:** Uses `context.Background()` + timeout (not request context). If the triggering request is cancelled, the load still completes for other waiters.
- **Document handler:** Uses `context.WithCancel` as a single cancellation mechanism, replacing any stop channel pattern.
  - Cancel context on: auth failure, heartbeat timeout, idle timeout, JWT expiry.
  - Read loop uses `conn.Read(ctx)` for context-aware termination -- when context is cancelled, the read returns immediately.
- **Project handler:** Same pattern -- `context.WithCancel` replaces stop channels.

### Error Modeling

Define sentinel errors for structured error handling at the handler boundary:

- `ErrAuthFailed` -- JWT invalid or missing
- `ErrAuthExpired` -- JWT expired (detected on heartbeat check)
- `ErrConnectionLimit` -- per-user connection limit exceeded
- `ErrFrameTooLarge` -- application-level size check failed

Refactor `bootstrapAuth` to return `(*collabAuthResult, error)`, not `(*collabAuthResult, string)`. The string return for error messaging conflates error type with error message. Map sentinel errors to WS error codes at the handler boundary:

```
switch {
case errors.Is(err, ErrAuthFailed):   sendError("AUTH_FAILED"); close
case errors.Is(err, ErrAuthExpired):  sendError("AUTH_EXPIRED"); close
case errors.Is(err, ErrConnectionLimit): sendError("CONNECTION_LIMIT"); close
}
```

### Modify: `collab_message_loop.go`

Adapt for the simpler per-document case. The loop no longer needs to unwrap envelopes or route by document UUID. It receives raw binary and passes to the single document session.

The project WS gets its own simpler loop (JSON only, no binary).

### Modify: Proposal Broadcasting

`collab_proposal_broadcaster.go` -- the fanout is split across two transports:

- **JSON proposal events** (`proposal:snapshot`, `proposal:new`, `proposal:statusChanged`, `doc:edited`) -> **project WS** via `ProjectConnectionRegistry`. These are notifications/metadata only.
- **Yjs update bytes** (from accepted proposals) -> **document WS** via existing document broadcaster/session runtime. The proposal service applies the update to the in-memory Y.Doc, which then broadcasts to connected document WS clients through the normal Yjs fanout path.

Add: broadcast `{"type":"doc:edited","documentId":"...","source":"proposal_accepted"}` on the project WS when a proposal is accepted.

**Document broadcaster replacement:** `InMemoryDocumentBroadcaster` is replaced. The per-document WS handler manages its own fanout via a connection set (list of active connections for that document). The `ProjectConnection` interface changes from envelope-framed to raw binary with 1-byte prefix. Each handler maintains its connection set locally -- no centralized document broadcaster needed.

### Testing: goroutine leak detection

Use `go.uber.org/goleak` with `defer goleak.VerifyNone(t)` per-test, not a `TestMain`-level check. Per-test verification catches the specific test that leaks, making debugging easier.

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
  proposalManager: ProposalManager
  proposalReviewRuntime: ProposalReviewRuntime | null
  status: 'active' | 'warm' | 'disconnected'
  sendBinary(data: Uint8Array): void
  onStatusChange(handler: (status) => void): Unsubscribe
}
```

Session owns all document-scoped state that must survive the warm pool. Hook-local state (ephemeral UI like review revision selection) stays in the component.

**Initialization:** Must register `pagehide` (with `beforeunload` fallback) handler at initialization to call `closeAll()` on tab close. React unmount is secondary cleanup; heartbeat timeout is the server-side safety net.

**Lifecycle:**
- `acquire()` -- if session exists in warm pool and last heartbeat was within 60s, promote to active (instant, no resync). If session exists in warm pool but last heartbeat was >60s ago (stale), destroy and recreate (cold path). If cold, create new Y.Doc + IndexedDB + WS + runtime.
- `release()` -- move to warm pool. Session stays alive (WS open, Y.Doc in memory, updates applied). Max 3 warm, 5 min timeout, LRU eviction.
- On eviction or timeout -- close WS (which triggers server-side Release), destroy Y.Doc and IndexedDB provider.

**Health check:** If last heartbeat on a warm session was >60s ago, mark as stale. On next `acquire()`, treat as cold (destroy and recreate) rather than promoting a potentially dead session.

**Auth:** Each WS connection sends JWT as first message. Reuse `getAccessToken()` from existing auth.

**Reconnect:** Per-session backoff. One document reconnecting doesn't affect others.

**Instantiation and integration:**
- `DocumentSessionManager` is a **singleton created at app init**, NOT a React component or hook.
- Passed to components via React context, following the existing `ProjectCollabContext` pattern.
- Receives `getAccessToken()` callback at construction time for WS auth.
- `useCollabStore` interaction: store state is no longer bound to component lifecycle. The store tracks connection status (for UI indicators) but `DocumentSessionManager` owns the WS lifecycle. The store observes session status changes via `onStatusChange` callbacks.

**Lease generation (client-side warm pool):**

The warm pool is purely client-side. The server has no warm pool concept -- it sees open and closed connections.

```
acquire(docId):
  session = warmPool.get(docId) || activePool.get(docId)
  if session:
    session.leaseGeneration++   // invalidate any pending eviction
    move session from warm -> active
    return session
  // cold path: create new session (Y.Doc + IndexedDB + WS + runtime)
  session = createNewSession(docId)
  session.leaseGeneration = 1
  activePool.set(docId, session)
  return session

release(docId):
  session = activePool.remove(docId)
  warmPool.set(docId, session)
  capturedGen = session.leaseGeneration
  setTimeout(EVICTION_DELAY, () => {
    if session.leaseGeneration === capturedGen:
      // generation unchanged -- no acquire happened since release
      warmPool.remove(docId)
      // cleanup must destroy all resources:
      session.runtime.destroy()
      session.indexeddbProvider.destroy()
      session.yDoc.destroy()
      session.connection.close()  // triggers server-side Release via handler defer
  })
  // LRU eviction if warmPool.size > MAX_WARM:
  //   evict oldest, same destroy sequence as above
```

**Atomic eviction (M13):** The eviction callback must be atomic under a single lock acquisition: check generation, delete from warm pool map, and mark the session as "destroying" -- all under one lock. Then outside the lock: close the WS and flush. This prevents a race where `acquire()` grabs a session that is mid-destruction.

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
