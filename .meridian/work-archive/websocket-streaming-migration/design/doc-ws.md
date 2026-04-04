# Doc WS — Document Notification & Sync Connection

The doc WS handles document/proposal notifications and Yjs CRDT sync for a project. It replaces both the current project WS (`collab_project.go`) and the per-document Yjs WS (`collab_document_handler.go`) using the [generic protocol](protocol.md) via the [wsutil framework](framework.md).

**Endpoint**: `GET /ws/projects/{projectId}/docs`

Related: [overview.md](overview.md) for how this fits into the architecture, [frontend.md](frontend.md) for client-side integration, [protocol.md](protocol.md) for the wire format.

## Architecture

The doc WS uses both protocol lanes:

- **Notify lane**: Lightweight invalidation hints for proposals and documents. Broadcast to all project connections automatically. Unchanged from v1.
- **Stream lane**: Yjs CRDT sync for individual documents. Client subscribes to a document resource → receives Yjs sync/update data as binary frames. Client sends Yjs data back via binary frames.

```mermaid
flowchart TD
  subgraph DocWS["Doc WS (/ws/projects/{id}/docs)"]
    Notify["Notify Lane<br/>proposal/document invalidation"]
    Stream["Stream Lane<br/>Yjs CRDT sync per document"]
  end

  subgraph Clients["Client Connections"]
    C1["User A<br/>editing doc D1"]
    C2["User B<br/>editing doc D1, D2"]
  end

  C1 -->|"subscribe D1"| Stream
  C2 -->|"subscribe D1, D2"| Stream
  Notify -->|broadcast| C1
  Notify -->|broadcast| C2
  Stream -->|"D1 sync events"| C1
  Stream -->|"D1, D2 sync events"| C2
```

## What Gets Replaced

### Current project WS (`collab_project.go`) — replaced in prior phases

- `ProjectConnectionRegistry` and `ProjectBroadcaster` → framework's built-in connection registry + `DocNotifier`

### Current per-document Yjs WS (`collab_document_handler.go`) — replaced by stream lane

| Current (per-doc WS) | New (doc WS stream lane) |
|---|---|
| Per-document endpoint `GET /ws/documents/{documentId}` | Doc WS stream lane subscriptions |
| Direct binary frames (0x00 sync, 0x01 awareness) | Binary frames with subId routing prefix |
| Per-document auth/heartbeat/reconnect | Framework handles at connection level |
| `CollabDocumentHandler.documentConns` fanout map | `DocHandler.docSubs` cross-connection registry |
| `DocumentBroadcaster.BroadcastToDocument()` | `DocHandler.BroadcastYjsUpdate()` |
| `BroadcastDocumentRestored()` | Stream `ended{reason: document_restored}` to subscribers |
| `HasOwnerTabs()` | `DocHandler.HasActiveSubscribers()` |

## Handler Registration

```go
docHandler := handler.NewDocHandler(
    sessionManager,    // collab.DocumentSessionProvider
    documentResolver,  // collab.DocumentResolver
    logger,
)

docServer := wsutil.NewServer(
    wsutil.WithAuth(authenticator),
    wsutil.WithHeartbeat(20*time.Second, 20*time.Second),
    wsutil.WithRateLimit(30),
    wsutil.WithOriginPatterns(allowedOrigins...),
    wsutil.WithReadLimit(256 * 1024), // 256KB — matches current per-document WS app-level max
)
docServer.RegisterHandler("document", docHandler)
mux.HandleFunc("GET /ws/projects/{projectId}/docs", docServer.Serve)
```

**ReadLimit 256KB**: Matches the current per-document WS application-level max for raw binary Yjs frames. Binary frames carry raw Yjs data directly — no base64 encoding overhead.

## Doc Handler

Replaces the v1 `DocNotifyHandler` (which returned `ErrNotSupported` for all stream operations). Now implements `wsutil.BinaryHandler` (which extends `Handler`) with Yjs sync support via binary frames.

```go
type DocHandler struct {
    sessionManager   collab.DocumentSessionProvider
    documentResolver collab.DocumentResolver
    logger           *slog.Logger

    // Cross-connection document subscriber registry.
    // Maps documentID → active subscribers across ALL connections.
    // Used for Yjs update fanout: when one subscriber sends an update,
    // broadcast to all other subscribers of the same document.
    docSubsMu sync.RWMutex
    docSubs   map[string][]*docSubscriber
}

type docSubscriber struct {
    session     wsutil.Session     // framework egress API for this connection
    subId       string             // subscription ID on this connection
    syncSession collab.SyncSession // reference-counted Yjs session
    releaseFn   func()             // session release (decrements ref count)
    documentID  string             // for reverse lookup on unsubscribe
    epoch       string             // random UUID, identifies this subscription instance
    seq         atomic.Int64       // monotonic per subscription, used in JSON envelopes (ended, gap)
}
```

### Per-Connection State

```go
type docHandlerState struct {
    session wsutil.Session
    // documentID → local subscription info.
    // Used for duplicate subscribe detection (OnSubscribe) and unsubscribe cleanup.
    subsByDoc map[string]*docSubscriber
    // subId → local subscription info.
    // Used by OnBinaryMessage to route binary frames to the right subscriber.
    subsBySubId map[string]*docSubscriber
}
```

### OnConnect / OnDisconnect

`OnConnect` creates per-connection state with an empty subscription map. Returns `&docHandlerState{session: session, subs: make(...)}`.

`OnDisconnect` is a no-op — the framework calls `EndSub` for all active subscriptions before `OnDisconnect`, which triggers `OnUnsubscribe` for each, handling all cleanup (registry removal, session release).

## Notify Events

Unchanged from v1. The notify lane broadcasts proposal/document invalidation hints to all project connections via `Broadcaster.BroadcastNotify()`. These do NOT go through the handler — the framework broadcasts them directly.

| Event | Resource | Payload | When |
|---|---|---|---|
| `created` | `proposal` | `{ "event": "created", "documentId": "..." }` | New proposal created |
| `accepted` | `proposal` | `{ "event": "accepted", "documentId": "..." }` | Proposal accepted |
| `rejected` | `proposal` | `{ "event": "rejected", "documentId": "..." }` | Proposal rejected |
| `updated` | `document` | `{ "event": "updated" }` | Document content changed |
| `error` | `document` | `{ "event": "error", "code": "...", "message": "..." }` | Document error |

### Notify Emission

Service-layer code emits notifications through `DocNotifier` — a typed wrapper around `wsutil.Broadcaster`:

```go
type DocNotifier interface {
    NotifyProposal(projectID string, proposalID string, event string, documentID string)
    NotifyDocument(projectID string, documentID string, event string)
    NotifyDocumentError(projectID string, documentID string, code string, message string)
}
```

## Document Stream: Yjs CRDT Sync

### Binary Frame Transport

Yjs uses binary data (`[]byte` / `Uint8Array`). Yjs payloads are sent as **binary WebSocket frames** using the protocol's [binary frame format](protocol.md#binary-frames) — a subId routing prefix followed by the raw binary payload. No JSON wrapping, no base64 encoding.

**Server → Client**: The handler calls `session.SendBinaryToSub(subId, payload)`. The framework prepends the subId prefix and writes a binary WebSocket frame.

**Client → Server**: The client sends a binary frame with the subId prefix. The framework extracts the subId, looks up the subscription, and calls the handler's `OnBinaryMessage(state, subId, data)`.

Control messages (subscribe, unsubscribe, subscribed, ended, gap) remain JSON text frames. Only Yjs sync and awareness data uses binary frames.

### Binary Payload Types

The raw binary payload in each binary frame includes a Yjs protocol prefix byte — same encoding as the current per-document WS:

| Prefix Byte | Type | Description |
|---|---|---|
| `0x00` | Sync | Yjs sync protocol message (step 1, step 2, or update) |
| `0x01` | Awareness | Yjs awareness update (cursor positions, user names) |

The **prefix byte** is authoritative for handler dispatch. The handler reads the first byte of the binary payload to determine the message type, then processes the remaining bytes as Yjs protocol data.

**Application-level size check**: The handler applies a 256KB limit on the binary payload (matching the current `docWSAppMaxFrame`).

### Subscribe Lifecycle

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server (DocHandler)
  participant Y as SyncSession

  C->>S: subscribe { resource: { type: "document", id: "D1" }, subId: "s-1" }

  Note over S: OnSubscribe
  S->>S: Verify document ownership
  S->>Y: GetOrCreateSession(D1, userID)
  S->>Y: BuildSyncStep1Payload()

  S->>C: subscribed { subId: "s-1", epoch: "..." }
  S->>C: binary frame: syncStep1
  S->>S: Register in cross-connection docSubs

  rect rgba(128, 128, 128, 0.08)
    Note over C,S: Steady state: bidirectional Yjs sync
    C->>S: binary frame: clientSyncStep2
    S->>Y: HandleSyncPayload(data)
    S->>C: binary frame: response

    C->>S: binary frame: update
    S->>Y: HandleSyncPayload(data)
    Note over S: If update produced, broadcast to other D1 subscribers
  end

  C->>S: unsubscribe { subId: "s-1" }
  S->>S: Remove from docSubs, release session
  S->>C: unsubscribed { subId: "s-1" }
```

### OnSubscribe

1. **Deduplicate**: If this connection already has a subscription for the same document, end the old subscription first (`session.EndSub(oldSubId)` → triggers `OnUnsubscribe` → cleanup). Same pattern as the thread handler for duplicate turn subscriptions.
2. **Authorize**: `documentResolver.VerifyOwnership(ctx, documentID, userID)`. Failure → framework sends `SUBSCRIBE_FAILED` error.
3. **Acquire session**: `sessionManager.GetOrCreateSession(ctx, documentID, userID)` → returns `SyncSession` + release function. Sessions are reference-counted — multiple subscribers to the same document share the same underlying Yjs document state. **Use a deferred release guard**: set a `registered` flag, defer `if !registered { releaseFn() }`. This prevents session reference leaks if any subsequent step fails and OnSubscribe returns an error (the framework does NOT call OnUnsubscribe on subscribe failure).
4. **Build sync step 1**: `session.BuildSyncStep1Payload()` → binary Yjs sync-step-1 data.
5. **Generate epoch**: Random UUID identifying this subscription instance.
6. **Send subscribed**: Control message confirming subscription with `epoch`.
7. **Send initial sync**: Binary frame with Yjs sync step 1 payload via `session.SendBinaryToSub(subId, prefixed(syncStep1))`.
8. **Register**: Add subscriber to per-connection state (`subsByDoc[documentID]` + `subsBySubId[subId]`) and cross-connection registry (`DocHandler.docSubs[documentID]`). Set `registered = true` to prevent the deferred release.

### OnUnsubscribe

1. Remove subscriber from per-connection state.
2. Remove subscriber from cross-connection registry.
3. Release Yjs session reference (`releaseFn()`).

### OnBinaryMessage (Client → Server Yjs Data)

Client sends Yjs data as a binary frame with the subId routing prefix:

`<subId> 0x00 <Yjs binary payload>`

The framework extracts the subId and calls `OnBinaryMessage(state, subId, data)`.

Handler processing:

1. Look up subscriber in per-connection state by subId (`subsBySubId[subId]`). Not found → error.
2. Read the prefix byte from `data`, dispatch by type:
   - **Sync (0x00)**: Call `syncSession.HandleSyncPayload(ctx, data[1:], "human")`.
     - If `responsePayload` non-empty: send binary frame back to sender via `session.SendBinaryToSub(subId, prefixed(response))`.
     - If `updatePayload` non-empty: prefix the update, then broadcast to all OTHER subscribers of the same document via cross-connection registry using `broadcastToDocSubscribers`.
   - **Awareness (0x01)**: Log receipt. Fanout deferred (see [Awareness](#awareness) below).

### Cross-Connection Fanout

When a Yjs update needs to be broadcast (from a client edit or a server-initiated action like proposal acceptance), the handler iterates the cross-connection registry:

```go
func (h *DocHandler) broadcastToDocSubscribers(
    documentID string,
    excludeSubId string, // empty string = send to all
    data []byte,         // raw Yjs binary payload (with prefix byte)
) {
    h.docSubsMu.RLock()
    subs := h.docSubs[documentID]
    targets := make([]*docSubscriber, 0, len(subs))
    for _, sub := range subs {
        if sub.subId != excludeSubId {
            targets = append(targets, sub)
        }
    }
    h.docSubsMu.RUnlock()

    for _, target := range targets {
        _ = target.session.SendBinaryToSub(target.subId, data)
    }
}
```

**Snapshot-then-send**: Read-lock the registry, copy targets, release lock, then send outside the lock. Same pattern as `wsutil.BroadcastNotify` — prevents deadlock when a send failure triggers connection removal. `SendBinaryToSub` failures (dead connection, queue full) are handled by the framework — the handler doesn't need to clean up failed sends.

### Server-Initiated Broadcasts

Two service-layer actions broadcast Yjs data to document subscribers:

#### Proposal Acceptance

When a proposal is accepted, the Yjs document is updated server-side. The update must be broadcast to all connected editors:

```go
// DocHandler implements this interface for ProposalBroadcaster integration.
// Replaces DocumentBroadcaster.BroadcastToDocument().
type DocumentSyncBroadcaster interface {
    BroadcastYjsUpdate(documentID string, update []byte)
}
```

The handler prefixes the update with the sync byte (`0x00`) and broadcasts as binary frames to all document subscribers via `broadcastToDocSubscribers`. No sender exclusion — server-initiated updates go to everyone.

#### Document Restored

When a document is restored from a bookmark, the backend replaces the persisted Yjs state. All connected editors must discard local state and re-sync.

The handler sends `stream:ended` with `reason: "document_restored"` to all subscribers, then calls `EndSub` for each to clean up:

```json
{
  "kind": "stream",
  "op": "ended",
  "subId": "s-1",
  "resource": { "type": "document", "id": "D1" },
  "payload": { "reason": "document_restored" }
}
```

**Important**: The `ended` event MUST be sent via `session.Send()`, NOT `session.SendToSub()`. `Send()` routes `stream:ended` through the control queue (since `op != "event"`). If sent via `SendToSub()`, the event would be orphaned — `EndSub` removes the subscription from `subOrder` before the writer loop drains the per-subscription queue.

The flow: `session.Send(endedEnvelope)` → `session.EndSub(subId)` → framework calls `OnUnsubscribe` → handler removes from registry and releases session reference.

**Client behavior**: The client receives `ended{reason: "document_restored"}` and emits a `document-restored` control event to the editor. The client does NOT auto-reconnect immediately — the current restore flow broadcasts the restored event before rebuilding the session (`rebuildFrozenDocuments`), so an immediate re-subscribe would hit a frozen session and fail. Instead, the editor handles the control event (e.g., shows a reload prompt, or retries with backoff after the session is rebuilt).

### HasActiveSubscribers

Replaces `CollabDocumentHandler.HasOwnerTabs()`. Checks whether any subscriptions exist for a document in the cross-connection registry:

```go
func (h *DocHandler) HasActiveSubscribers(documentID string) bool {
    h.docSubsMu.RLock()
    defer h.docSubsMu.RUnlock()
    return len(h.docSubs[documentID]) > 0
}
```

### Awareness

Awareness (cursor positions, user presence) is per-document. Clients send awareness updates as binary frames with the awareness prefix byte (`0x01`). The server currently logs them — **awareness fanout is deferred** (same as the current `collab_document_handler.go` Phase 5 stub).

When awareness fanout is implemented, the handler broadcasts awareness binary frames to all other subscribers of the same document, using the same `broadcastToDocSubscribers` mechanism as sync updates.

### Seq/Epoch Semantics for Documents

- **epoch**: Identifies the Yjs session instance (random UUID). Server restart → sessions gone → client re-subscribes with old epoch → handler doesn't recognize it → gap → client re-subscribes fresh.
- **seq**: The framework tracks per-subscription event counts internally (binary frames and JSON events both count toward backpressure). Binary frames don't carry seq. JSON envelopes (`ended`, `gap`) include the current seq value.
- **Gap recovery**: Much simpler than for thread streaming. Client re-subscribes with no `lastSeq`/`epoch`, triggering a full sync-step-1 exchange. CRDTs naturally support this — no REST fallback needed, no gap counting. A fresh subscribe always converges to the correct state.

### Connection Limits

No per-subscription idle timeout. Document subscriptions stay active as long as the editor is open. The framework provides connection-level protection: max 10 subscriptions per connection, heartbeat keepalive (20s), per-connection rate limiting (30 msg/s).

The current per-document WS has a 5-minute idle timeout — that was DoS mitigation for standalone connections. In the doc WS, per-connection limits provide equivalent protection without individual subscription timeouts.

## Key Files

| Area | File | Status |
|---|---|---|
| Doc handler | `backend/internal/handler/doc_ws_handler.go` | Upgrade from notify-only to full handler |
| Per-doc WS (to be removed) | `backend/internal/handler/collab_document_handler.go` | Remove after migration |
| Shared collab infra | `backend/internal/handler/collab.go` | Keep (shared types, helpers) |
| Proposal broadcaster | `backend/internal/handler/collab_proposal_broadcaster.go` | Update `DocumentBroadcaster` → `DocumentSyncBroadcaster` |
| Document broadcaster interface | `backend/internal/handler/collab_document_broadcaster.go` | Replace with `DocumentSyncBroadcaster` |
| Presence interface | `backend/internal/domain/collab/presence.go` | Update `OwnerTabPresenceTracker.HasOwnerTabs` → `HasActiveSubscribers` |
| Proposal service (presence caller) | `backend/internal/service/collab/proposal_service.go` | Update presence interface usage |
| Restore service (broadcast caller) | `backend/internal/service/collab/restore_service.go` | Update `BroadcastDocumentRestored` caller |
| Auth | `backend/internal/handler/collab_authenticator.go` | Reuse |
| Session domain | `backend/internal/domain/collab/session.go` | No changes |
| Session manager | `backend/internal/service/collab/session_manager.go` | No changes |
| Domain wiring | `backend/internal/app/domains/collab.go` | Update handler construction + remove per-doc route |
