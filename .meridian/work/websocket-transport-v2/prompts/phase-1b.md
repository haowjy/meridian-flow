# Phase 1B: Project WS Simplification

You are implementing Phase 1B of the ws-transport-v2 plan. This phase simplifies the project WebSocket to be JSON-only by removing all binary/subscription handling. The per-document WebSocket handler was already created in Phase 1A.

## Current State

- Phase 0 complete: dependencies, error sentinels, session manager fixes, authenticator refactor
- Phase 1A complete: `collab_document_handler.go` with per-document WS, `project_connection_registry.go` with ISP interfaces
- The project WS handler (`collab_project.go`) still has the old multiplexed binary+subscription code

## What to Change

### 1. `backend/internal/handler/collab.go` — Update CollabHandler struct

**Remove fields:**
- `documentBroadcaster collabSvc.DocumentBroadcaster` — no longer needed
- `subscriptionService *serviceCollab.SubscriptionService` — subscriptions eliminated

**Add fields:**
- `projectRegistry ProjectBroadcaster` — for broadcasting JSON proposal events to project WS connections
- `docHandler *CollabDocumentHandler` — for document-level binary fanout (Yjs updates from proposal acceptance)

**Update `NewCollabHandler`:**
- Remove `documentBroadcaster` and `subscriptionService` parameters
- Add `projectRegistry ProjectBroadcaster` and `docHandler *CollabDocumentHandler` parameters
- Update the struct initialization

### 2. `backend/internal/handler/collab_project.go` — Simplify to JSON-only

**Remove entirely:**
- `handleDocSubscribe()` method — no subscription protocol in v2
- `handleDocUnsubscribe()` method — no subscription protocol in v2
- `handleProjectBinaryMessage()` method — no binary frames on project WS

**Remove from `handleProjectSocket`:**
- `defer h.subscriptionService.UnsubscribeAll(ctx, connectionID)` — no subscriptions

**Add to `handleProjectSocket`:**
- After auth succeeds, register in project connection registry:
  ```go
  projectConn := &projectWSConnection{wsConn: wsConn}
  h.projectRegistry.Register(projectID, connectionID, projectConn)  // wait, projectRegistry is ProjectBroadcaster, not ProjectConnectionRegistrar
  ```
  Actually, `CollabHandler` needs `ProjectConnectionRegistrar` (the Register/Unregister interface), not just `ProjectBroadcaster`. But for proposal broadcasting it needs `ProjectBroadcaster`. Since `InMemoryProjectConnectionRegistry` satisfies both, store it as `*InMemoryProjectConnectionRegistry` or use a combined interface. The cleanest approach: store it as `*InMemoryProjectConnectionRegistry` since the handler needs both Register and Broadcast.
- `defer h.projectRegistry.Unregister(connectionID)` for cleanup
- Create a `projectWSConnection` adapter that satisfies `ProjectConnection`:
  ```go
  type projectWSConnection struct {
      wsConn *websocketDocumentConnection
  }
  func (c *projectWSConnection) Send(data []byte) error {
      return c.wsConn.Send(data)
  }
  ```

**Update `handleProjectTextMessage` switch:**
- Remove `wsTypeDocSubscribe` and `wsTypeDocUnsubscribe` cases
- Keep `wsTypeHeartbeat` and proposal cases

**Update `handleProjectProposalCommand`:**
- Remove `GetSubscription(connectionID, documentID)` check
- Remove `getSubscriptionInvalidationReason` check
- Replace with `h.authenticator.checkDocumentAccess(ctx, projectID, userID, documentID)`
- The proposal handlers need `docID` (string) and `docUUID` (uuid.UUID) — get these from the command payload's documentId field (already parsed)
- Add per-connection document access cache: pass a `map[string]bool` (documentID -> validated) so we only check access once per document per connection. Create it in `handleProjectSocket` and pass it through to `handleProjectTextMessage` and `handleProjectProposalCommand`.

**Update `runMessageLoop` call:**
- Pass `nil` for `onBinaryMessage` handler (JSON only)

**Remove:**
- Import of `serviceCollab "meridian/internal/service/collab"` if no longer needed
- Any other dead imports

### 3. `backend/internal/handler/collab_proposal.go` — Split broadcast paths

**Update `broadcastProposalMutations`:**
- Add `projectID string` parameter
- For Yjs update frames (accepted proposals): broadcast through `h.docHandler.BroadcastToDocument(documentID, updateFrame)`
- For JSON events (proposal:statusChanged): broadcast through `h.projectRegistry.BroadcastToProject(projectID, statusEventBytes)`
- All callers pass their known `projectID`

**Update `handleProposalGroupAccept`:**
- The `h.documentBroadcaster.Broadcast(docID, groupEventBytes, nil)` at the end needs to become `h.projectRegistry.BroadcastToProject(projectID, groupEventBytes)`
- This method has access to `projectID` already? Check the parameters — it receives `docID` and `docUUID` but NOT `projectID`. It needs `projectID` now. Update the caller in `handleProjectProposalCommand` to also pass `projectID`.

**Update all proposal handler signatures if needed** to accept `projectID` where they call `broadcastProposalMutations`.

### 4. `backend/internal/handler/collab_document_handler.go` — Add public broadcast method

Add a public method that proposal code can call to fan out binary frames:

```go
// BroadcastToDocument sends binary data to all connections for the given document.
// Used by proposal acceptance to fan out Yjs update frames.
func (h *CollabDocumentHandler) BroadcastToDocument(documentID string, data []byte) {
    h.documentConnMu.RLock()
    defer h.documentConnMu.RUnlock()
    conns := h.documentConns[documentID]
    for conn := range conns {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        _ = conn.Write(ctx, websocket.MessageBinary, data)
        cancel()
    }
}
```

### 5. `backend/internal/handler/collab_proposal_broadcaster.go` — Switch to project broadcaster

**Replace `documentBroadcaster` with:**
- `projectBroadcaster ProjectBroadcaster` — for JSON events
- `docHandler *CollabDocumentHandler` — for Yjs binary updates
- `documentResolver collabSvc.DocumentResolver` — to resolve document -> project for `BroadcastToProject`

**Update `NewProposalBroadcasterImpl`:** Accept new dependencies.

**Update `BroadcastProposalCreated`:**
- Resolve documentID -> projectID via `documentResolver.ResolveDocument`
- Send JSON via `projectBroadcaster.BroadcastToProject(projectID, eventBytes)`

**Update `BroadcastProposalAccepted`:**
- Yjs update: `docHandler.BroadcastToDocument(documentID, updateFrame)`
- JSON status event: resolve documentID -> projectID, then `projectBroadcaster.BroadcastToProject(projectID, statusEventBytes)`

### 6. `backend/cmd/server/main.go` — Update wiring

- Create `projectConnectionRegistry := handler.NewInMemoryProjectConnectionRegistry()`
- Update `NewCollabHandler` call: remove `collabBroadcaster` and `collabSubscriptionService`, add `projectConnectionRegistry` and `collabDocumentHandler`
- Update `NewProposalBroadcasterImpl` call: pass `projectConnectionRegistry`, `collabDocumentHandler`, `collabDocResolver`

### 7. `backend/internal/handler/collab_project_subscription.go` — Leave for Phase 2

This file defines message types (`wsTypeDocSubscribe`, etc.) and the `multiplexedConnection`. The message type constants may still be referenced. If they cause compilation errors after removing the subscription code, either:
- Move the still-needed constants elsewhere
- Or just leave this file alone and let Phase 2 handle cleanup

## Important Constraints

- Must compile: `cd backend && go vet ./...` and `cd backend && go build ./...` must pass
- Run `gofmt -w` on all modified files
- Don't delete any files — Phase 2 handles file deletion
- The project WS still uses `golang.org/x/net/websocket` (old library) — don't change the WS library for the project handler
- Keep `collabInboundRateTracker` and rate limiting for the project WS
- Keep the heartbeat pattern unchanged

## Verification

1. `cd backend && go vet ./...` — must pass
2. `cd backend && go build ./...` — must pass
3. If tests exist, `cd backend && go test ./internal/handler/... -count=1 -timeout 30s`

## Reference Files

Read these files before making changes:
- `backend/internal/handler/collab.go` — main struct
- `backend/internal/handler/collab_project.go` — to be simplified
- `backend/internal/handler/collab_proposal.go` — broadcast split
- `backend/internal/handler/collab_proposal_broadcaster.go` — broadcaster update
- `backend/internal/handler/collab_document_handler.go` — add BroadcastToDocument
- `backend/internal/handler/project_connection_registry.go` — ISP interfaces
- `backend/internal/handler/collab_message_loop.go` — message loop
- `backend/internal/handler/collab_project_subscription.go` — types being removed
- `backend/internal/handler/collab_authenticator.go` — checkDocumentAccess
- `backend/cmd/server/main.go` — wiring
- `backend/internal/domain/services/collab/collab.go` — domain interfaces
