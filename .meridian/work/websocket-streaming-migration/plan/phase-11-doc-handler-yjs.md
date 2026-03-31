# Phase 11: Doc Handler Yjs Stream Support

## Scope

Upgrade `DocNotifyHandler` to a full `DocHandler` with Yjs CRDT sync via the stream lane. Replace `CollabDocumentHandler` as the Yjs sync transport. Update all interfaces and callers that depend on `DocumentBroadcaster`, `OwnerTabPresenceTracker`, and `BroadcastDocumentRestored`.

This is the backend-heavy phase — handler, interface migration, and domain wiring.

## Design Reference

- [doc-ws.md](../design/doc-ws.md) — full handler specification
- [overview.md](../design/overview.md) §D34-D38 — Yjs multiplexing decisions
- [decisions.md](../decisions.md) §D39-D42 — review-driven refinements

## What's In Scope

1. Upgrade `doc_ws_handler.go`: `DocNotifyHandler` → `DocHandler` with full `wsutil.Handler` implementation (OnSubscribe/OnUnsubscribe/OnMessage)
2. Cross-connection document subscriber registry (`docSubs map[string][]*docSubscriber`)
3. Yjs sync subscribe lifecycle (authorize → acquire session → sync step 1 → register)
4. Yjs message handling (base64 decode → prefix dispatch → HandleSyncPayload → fanout)
5. `BroadcastYjsUpdate()` — server-initiated Yjs broadcast for proposal acceptance
6. `BroadcastDocumentRestored()` — stream:ended + EndSub for all document subscribers
7. `HasActiveSubscribers()` — replaces `HasOwnerTabs()`
8. Interface migration: `DocumentBroadcaster` → `DocumentSyncBroadcaster`
9. Interface migration: `OwnerTabPresenceTracker` → update to use `HasActiveSubscribers`
10. Update domain wiring in `collab.go` — new constructor args, ReadLimit 512KB, remove per-doc WS route
11. Update all callers: `collab_proposal_broadcaster.go`, `proposal_service.go`, `restore_service.go`

## What's Out of Scope

- Frontend changes (Phase 12)
- Removing `collab_document_handler.go` file (Phase 13 — keep until frontend is migrated)
- Awareness fanout (deferred, per design doc)

## Prerequisites

- Phases 1-10 complete (wsutil framework, doc WS endpoint, notify handler all working)

## Files to Create/Modify

### Upgrade: `backend/internal/handler/doc_ws_handler.go`

Complete rewrite from notify-only stub to full handler. Key structures:

```go
type DocHandler struct {
    sessionManager   collab.DocumentSessionProvider
    documentResolver collab.DocumentResolver
    logger           *slog.Logger

    docSubsMu sync.RWMutex
    docSubs   map[string][]*docSubscriber
}

type docSubscriber struct {
    session     wsutil.Session
    subId       string
    syncSession collab.SyncSession
    releaseFn   func()
    documentID  string
    epoch       string
    seq         atomic.Int64
}

type docHandlerState struct {
    session wsutil.Session
    subs    map[string]*docSubscriber
}
```

Implement all `wsutil.Handler` methods per [doc-ws.md](../design/doc-ws.md) §Doc Handler:
- **OnConnect**: Create `docHandlerState` with empty subs map
- **OnSubscribe**: Dedup → authorize → acquire session (deferred release guard, D39) → build sync step 1 → generate epoch → send subscribed → send initial sync (seq:1) → register in both per-connection and cross-connection registries
- **OnUnsubscribe**: Remove from per-connection state, remove from cross-connection registry, release session
- **OnMessage**: Lookup by resource.id → base64 decode → 256KB post-decode limit → strip prefix → dispatch by prefix byte (0x00 sync, 0x01 awareness)
- **OnDisconnect**: No-op (framework calls EndSub for all subs → OnUnsubscribe handles cleanup)

Cross-connection fanout: `broadcastToDocSubscribers()` with snapshot-then-send pattern (read-lock, copy targets, release, send outside lock).

Server-initiated broadcasts:
- `BroadcastYjsUpdate(documentID string, update []byte)`: base64-encode, broadcast to all subscribers (no exclusion)
- `BroadcastDocumentRestored(documentID string)`: Send `stream:ended{reason: "document_restored"}` via `session.Send()` (NOT `SendToSub()`, per D40), then `EndSub` for each subscriber
- `HasActiveSubscribers(documentID string) bool`: Check cross-connection registry

### Replace: `backend/internal/handler/collab_document_broadcaster.go`

Replace `DocumentBroadcaster` interface with `DocumentSyncBroadcaster`:

```go
type DocumentSyncBroadcaster interface {
    BroadcastYjsUpdate(documentID string, update []byte)
    BroadcastDocumentRestored(documentID string)
    HasActiveSubscribers(documentID string) bool
}
```

### Modify: `backend/internal/handler/collab_proposal_broadcaster.go`

- Change `docBroadcaster DocumentBroadcaster` field → `docSyncBroadcaster DocumentSyncBroadcaster`
- `BroadcastProposalAccepted()`: Replace `b.docBroadcaster.BroadcastToDocument(canonicalDocumentID, addDocPrefix(...))` with `b.docSyncBroadcaster.BroadcastYjsUpdate(canonicalDocumentID, yjsUpdate)`. The handler now handles base64 encoding and prefix construction — the broadcaster passes raw update bytes.
- Update `NewProposalBroadcasterImpl` constructor signature

### Modify: `backend/internal/domain/collab/presence.go`

Update `OwnerTabPresenceTracker` interface. Two options:
- **Option A** (minimal): Rename to reflect new implementation. Keep `HasOwnerTabs` name since the semantic is the same (are there active connections for this document?).
- **Option B** (cleaner): Rename interface to `DocumentPresenceTracker` and method to `HasActiveSubscribers`. Update all callers.

Use **Option B** — the design doc specifies `HasActiveSubscribers` and the old name is misleading now that "tabs" are subscriptions, not standalone WS connections.

### Modify: `backend/internal/service/collab/proposal_service.go`

- Update `ownerTabTracker collab.OwnerTabPresenceTracker` field → `presenceTracker collab.DocumentPresenceTracker`
- Update constructor parameter
- Update `s.ownerTabTracker.HasOwnerTabs(...)` call → `s.presenceTracker.HasActiveSubscribers(...)`

### Modify: `backend/internal/service/collab/restore_service.go`

- Update `restoreBroadcaster` interface: `BroadcastDocumentRestored(documentID string)` — no signature change but the implementation is now `DocHandler` instead of `CollabDocumentHandler`
- No code change needed in restore_service.go itself — it uses the local `restoreBroadcaster` interface which has the same method signature

### Modify: `backend/internal/app/domains/collab.go`

- Replace `NewDocNotifyHandler(infra.Logger)` with `NewDocHandler(collabSessionManager, collabDocResolver, infra.Logger)`
- Change ReadLimit: `wsutil.WithReadLimit(64*1024)` → `wsutil.WithReadLimit(512*1024)` (D37)
- Update `ProposalBroadcasterImpl` constructor: pass `docHandler` (which implements `DocumentSyncBroadcaster`) instead of `collabDocumentHandler` (which implements `DocumentBroadcaster`)
- Update `ProposalService` constructor: pass `docHandler` instead of `collabDocumentHandler` for presence tracking
- Update `RestoreService` constructor: pass `docHandler` instead of `collabDocumentHandler` for broadcast
- Remove `GET /ws/documents/{documentId}` route — **Wait**: don't remove yet if frontend still uses it. Remove in Phase 13.
- Update `CollabModule` struct: change `DocumentHandler` type or add `DocHandler` field

### Modify: `backend/internal/service/collab/proposal_service_test.go`

- Update `fakeOwnerTabPresenceTracker` → `fakeDocumentPresenceTracker`
- Update `HasOwnerTabs` → `HasActiveSubscribers`

### Modify: `backend/internal/service/collab/restore_service_test.go`

- Verify `fakeRestoreBroadcaster` still works (same method signature — should be fine)

## Interface Contract

The `DocHandler` implements three interfaces used by service-layer code:

```go
// For proposal acceptance Yjs fanout
type DocumentSyncBroadcaster interface {
    BroadcastYjsUpdate(documentID string, update []byte)
    BroadcastDocumentRestored(documentID string)
    HasActiveSubscribers(documentID string) bool
}

// For presence checking (replaces OwnerTabPresenceTracker)
type DocumentPresenceTracker interface {
    HasActiveSubscribers(documentID string) bool
}
```

The `restoreBroadcaster` local interface in `restore_service.go` (`BroadcastDocumentRestored(documentID string)`) is already compatible — `DocHandler` implements it.

## Patterns to Follow

- `backend/internal/handler/thread_ws_handler.go` — OnSubscribe lifecycle, dedup pattern, deferred release
- `backend/internal/handler/collab_document_handler.go` — Yjs sync protocol dispatch (prefix bytes, HandleSyncPayload, encodeSyncUpdatePayload)
- `backend/internal/wsutil/ws.go` — Session.SendToSub() for stream events, Session.Send() for ended events

## Verification Criteria

- [ ] `go build ./backend/...` passes
- [ ] `go vet ./backend/...` passes
- [ ] `go test ./backend/internal/handler/...` passes
- [ ] `go test ./backend/internal/service/collab/...` passes (proposal_service_test, restore_service_test)
- [ ] Doc WS endpoint still accepts connections and delivers notify events
- [ ] Subscribe to a document resource → receive `subscribed` + sync step 1 stream event
- [ ] Send Yjs sync step 2 back → receive response if applicable
- [ ] Two connections subscribe to same document → edit on one → other receives update
- [ ] Unsubscribe → session reference released (no leak)
- [ ] `DocumentSyncBroadcaster.BroadcastYjsUpdate()` delivers to all subscribers
- [ ] `BroadcastDocumentRestored()` sends `stream:ended` via Send() then EndSub
- [ ] `HasActiveSubscribers()` returns correct state
- [ ] No references to `DocumentBroadcaster` interface remain (grep verification)
- [ ] No references to `HasOwnerTabs` or `OwnerTabPresenceTracker` remain in non-test code (grep verification)

## Agent Staffing

- **Implementer**: `coder` on strong reasoning model — handler has concurrency (cross-connection registry), deferred release guard, and multiple interface migration points
- **Reviewers**: 2x
  - 1x correctness + concurrency review (focus: registry locking, deferred release guard, Send vs SendToSub for ended, seq/epoch threading)
  - 1x design alignment review (focus: conformance with [doc-ws.md](../design/doc-ws.md), interface rename completeness)
- **Testing**: `verifier` (go build + go test + go vet)
- **Investigation**: `unit-tester` — write targeted tests for OnSubscribe/OnUnsubscribe/OnMessage, cross-connection fanout, and BroadcastDocumentRestored flow
