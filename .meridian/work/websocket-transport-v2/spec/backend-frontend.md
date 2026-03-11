---
detail: comprehensive
audience: developer
---
# Stage 1: Per-Document WebSocket

**Status:** implemented

Replaced the multiplexed per-project WS with per-document connections and a simplified project WS for cross-document events.

**Primary UX motivation:** The old implementation destroyed and rebuilt `Y.Doc`, `IndexeddbPersistence`, `CollabSyncRuntime`, and the WS connection on every document switch. The session manager eliminates redundant setup -- `DocumentSessionManager` manages per-document sessions with refCount-based lifecycle. Warm pool (instant switch-back) is deferred; current behavior destroys sessions on release.

## Backend Changes

### Dependencies (New or Updated)

| Package | Purpose | Notes |
|---------|---------|-------|
| `github.com/coder/websocket` | WS library for document handler | Context-native API, concurrent-write-safe. Project WS handler still uses `golang.org/x/net/websocket`. |
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

Stripped to JSON-only project events handler. See `handler/collab_project.go`.

**Removed:** binary message handling, `doc:subscribe`/`doc:unsubscribe`, envelope framing, `subscription_service` dependency.

**Kept:** auth handshake (`project:connected`), heartbeat, rate limiting (JSON only).

**Changed:**
- Proposal commands use direct `checkDocumentAccess()` instead of subscription-based access validation.
- Per-connection `documentAccessCache` (`map[string]bool`) caches access checks. No mutex needed -- single goroutine per connection. Cache lives for connection lifetime (see IL-4 in tracking log for stale-auth discussion).
- Proposals broadcast to project WS connections via `ProjectConnectionRegistry`.

**Note:** Project WS still uses `golang.org/x/net/websocket` (not migrated to `coder/websocket`). Migration is scoped to the new document handler only.

**Deferred:**
- `doc:edited` broadcast not implemented (IL-16) -- new functionality, not a regression.
- Origin validation not added to project WS handler (only document handler has it).

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

### Remove: Files Deleted

All deleted as planned: `collab_envelope.go`, `collab_project_subscription.go`, `subscription_service.go`, `subscription_service_test.go`.

### Modify: `session_manager.go`

See `service/collab/session_manager.go`.

**Implemented fixes:**
- **singleflight Acquire()** -- `singleflight.Group.Do(docID, loadFn)` prevents duplicate Y.Doc loads. Post-singleflight re-check kept as defensive programming (IL-2).
- **refCount guards** -- `ApplyUpdate()`/`GetStateSnapshot()` pin refCount under manager lock before operating. `releaseSessionRef` helper shared between Release() and operational unpin (IL-3).
- **Detached context** -- load function uses `context.Background()` + 30s timeout, not request context.

**Not implemented (divergence from plan):**
- **leaseGeneration** -- the server has no warm pool or delayed eviction. Release is synchronous: refCount hits 0 -> flush state -> destroy. No timer races to guard against.
- **Release() underflow guard** -- Release() returns error if session not found, but no explicit underflow log-and-return (refCount protected by mutex serialization).

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

Retained for project WS. Runs JSON-only message loop (no binary). `onBinaryMessage` handler is nil for project connections. Document WS has its own inline read loop in `collab_document_handler.go`.

### Modify: Proposal Broadcasting

See `handler/collab_proposal_broadcaster.go`. Fanout split across two transports:

- **JSON proposal events** (`proposal:snapshot`, `proposal:new`, `proposal:statusChanged`) -> **project WS** via `ProjectBroadcaster.BroadcastToProject()`
- **Yjs update bytes** (from accepted proposals) -> **document WS** via `DocumentBroadcaster.BroadcastToDocument()`

`doc:edited` broadcast not yet wired (deferred, IL-16).

**Document broadcaster:** `CollabDocumentHandler` implements `DocumentBroadcaster` interface. Per-document fanout via connection set (`map[string]map[*websocket.Conn]struct{}`). Snapshot-under-lock, send-outside-lock pattern (same fix applied to `BroadcastToProject` per IL-5).

### Testing: goroutine leak detection

Use `go.uber.org/goleak` with `defer goleak.VerifyNone(t)` per-test, not a `TestMain`-level check. Per-test verification catches the specific test that leaks, making debugging easier.

---

## Frontend Changes

### New: `DocumentSessionManager` (frontend)

See `frontend/src/core/cm6-collab/sync/DocumentSessionManager.ts`.

Manages per-document WS connections and `CollabSyncRuntime` instances. Sessions are tied to refCount -- when refCount hits 0, the session is destroyed immediately.

```typescript
interface DocumentSessionManager {
  acquire(documentId: string): DocumentSession   // get or create session, refCount++
  release(documentId: string): void              // refCount--, destroy if 0
  onStatusChange(documentId, callback): Unsubscribe
  destroy(): void                                // close all sessions
}

interface DocumentSession {
  documentId: string
  ws: WebSocket
  runtime: CollabSyncRuntime
  status: 'connecting' | 'authenticating' | 'syncing' | 'connected' | 'disconnected'
}
```

**What the session does NOT own** (divergence from plan): `Y.Doc`, `IndexeddbPersistence`, `ProposalManager`, `ProposalReviewRuntime` -- these remain in hook-level code (`useDocumentCollab`). The session manager owns only WS + runtime. This keeps the session manager focused on transport.

**Auth:** WS `onopen` -> resolve JWT via `getAuthToken()` callback -> send as first text message.

**Reconnect:** Per-session exponential backoff: `min(5s, 250ms * 2^attempt) + jitter(15%)`. Calls `runtime.reset()` before reconnecting to clear sync handshake state (fix for IL-10).

**Error handling:** `AUTH_FAILED` and `AUTH_EXPIRED` both trigger Supabase session refresh (fix for IL-11).

**Deferred (warm pool):** Plan called for warm pool with LRU eviction, leaseGeneration, health checks, `pagehide`/`beforeunload` handlers. All deferred (IL-15). Current behavior: `release()` immediately closes WS, destroys runtime, and removes from session map.

### Modify: `useDocumentCollab.ts`

See `frontend/src/features/documents/hooks/useDocumentCollab.ts`.

Pattern: `sessionManager.acquire(documentId)` on mount, `sessionManager.release(documentId)` on unmount. Hook still owns `Y.Doc`, `IndexeddbPersistence`, and proposal state -- session manager provides WS + runtime only.

Proposal events come from `useProjectCollab` via `registerDocumentListener` (unchanged pattern, different transport).

### Modify: `useProjectCollab.ts`

See `frontend/src/features/documents/hooks/useProjectCollab.ts`.

Refactored from a hook to a factory function (`createProjectCollabTransport`) + thin `useProjectCollab` hook wrapper. This enables testability via injected dependencies (`createWebSocket`, `resolveAccessToken`, timers).

**Removed:** `subscribeDocument`/`unsubscribeDocument`, `sendDocumentBinary`, binary message handling, `activeSubscriptions`, envelope parsing.

**Kept:** project WS lifecycle, auth handshake, heartbeat, proposal event routing, proposal command sending.

**Added:** `doc:error` event routing to document listeners (fix for IL-12).

**Deferred:** `doc:edited` event handling (IL-16).

### Removed Files

`envelope.ts` and `documentSubscriptionDebounce.ts` deleted as planned.

### Modify: `runtime.ts`

See `frontend/src/core/cm6-collab/sync/runtime.ts`.

Removed envelope wrapping. Raw Yjs protocol bytes with 1-byte prefix (`0x00`=sync, `0x01`=awareness) sent via `sendBinary()` callback.

Added `reset()` method to clear `didStartSync` flag on reconnect (fix for IL-10).

---

## Migration Strategy

Hard cutover. No feature flags. Collab has no deployed production users. Old code (envelope, subscription service, multiplexed binary) deleted.

---

## Verification

Automated: `go vet`, `go test`, `pnpm run lint`, `pnpm run build` all pass. Per-phase review cycles documented in `tracking/log.md`.

Manual testing deferred until warm pool and `proposal:snapshot` bootstrap (IL-13) are addressed.
