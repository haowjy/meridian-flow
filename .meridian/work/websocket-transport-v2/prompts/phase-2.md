# Phase 2: Cleanup — Delete dead code, update domain interfaces

You are implementing Phase 2 of the ws-transport-v2 plan. This phase cleans up dead code left behind after Phase 1A (per-document WS) and Phase 1B (project WS simplification).

## Current State

- Phase 0 complete: dependencies, error sentinels, session manager fixes, authenticator refactor
- Phase 1A complete: `collab_document_handler.go` with per-document WS, `project_connection_registry.go`
- Phase 1B complete: project WS simplified to JSON-only, broadcast paths split, tests updated
- Dead code remains from the old subscription/binary/envelope protocol

## What to Change

### 1. Delete these files entirely

- `backend/internal/handler/collab_envelope.go` — envelope framing no longer used (project WS is JSON-only, document WS uses raw 1-byte prefix)
- `backend/internal/service/collab/subscription_service.go` — subscription service no longer used
- `backend/internal/service/collab/subscription_service_test.go` — tests for deleted service

### 2. `backend/internal/handler/collab_project_subscription.go` — Move remaining symbols, then delete

This file still has symbols used by `collab_project.go`:
- `wsTypeDocError` — used for doc:error events
- `wsTypeProjectConnected` — used for project:connected event
- `docErrorEvent` struct — used for doc:error events

Move these to `collab_project.go` (or a new small file if cleaner), then delete `collab_project_subscription.go`.

### 3. `backend/internal/handler/collab.go` — Clean up

Remove dead code:
- `websocketDocumentConnection` — check if this is still used. It's used by the project WS handler (wraps old x/net/websocket). If still used, KEEP IT. Only remove if truly unused.
- Remove any unused imports
- Remove any dead methods or types related to the old subscription/binary flow
- The `collabInboundRateTracker` — check if still used by project WS. If yes, keep it.

### 4. `backend/internal/handler/collab_authenticator.go` — Remove dead code

- `getSubscriptionInvalidationReason` method — no longer called at runtime. Delete it.
- Any related types/imports used only by that method.
- Keep `checkDocumentAccess` and `bootstrapAuth` — these are actively used.
- If there are tests for `getSubscriptionInvalidationReason` in `collab_authenticator_test.go`, delete those tests too.

### 5. `backend/internal/domain/services/collab/collab.go` — Update domain interfaces

- Check if `DocumentBroadcaster` interface is still used anywhere. If not, remove it.
- Check if `SubscriptionManager` interface is still used anywhere. If not, remove it.
- Keep `DocumentResolver` — still used by authenticator and proposal broadcaster.
- Keep `ProposalService`, `ProposalStore` — still used.

### 6. `backend/internal/handler/collab_test.go` — Clean up

Remove any test helpers, spy types, or tests that are no longer used after the cleanup above.

### 7. Introduce DocumentBroadcaster interface (from review backlog IL-7)

Currently `CollabHandler` and `ProposalBroadcasterImpl` depend on concrete `*CollabDocumentHandler`. Introduce a narrow interface:

```go
// DocumentBroadcaster sends binary data to all WebSocket connections for a document.
type DocumentBroadcaster interface {
    BroadcastToDocument(documentID string, data []byte)
}
```

Place this in `project_connection_registry.go` (alongside other ISP interfaces) or a new `collab_interfaces.go` file.

Update `CollabHandler` and `ProposalBroadcasterImpl` to depend on `DocumentBroadcaster` instead of `*CollabDocumentHandler`. Update `NewCollabHandler` and `NewProposalBroadcasterImpl` signatures. Update `main.go` wiring (the concrete `*CollabDocumentHandler` satisfies the interface, so no wiring logic changes needed).

## Important Constraints

- Must compile: `cd backend && go vet ./...` and `cd backend && go build ./...` must pass
- Must test: `cd backend && go test ./internal/handler/... -count=1 -timeout 60s` must pass
- Also test: `cd backend && go test ./internal/service/collab/... -count=1 -timeout 60s` must pass (since deleting subscription_service)
- Run `gofmt -w` on all modified files
- Don't break any existing functionality — this is purely cleanup
- Check all imports after deletions — `go vet` will catch unused imports

## Verification

1. `cd backend && go vet ./...` — must pass
2. `cd backend && go build ./...` — must pass
3. `cd backend && go test ./... -count=1 -timeout 60s` — must pass (or at least handler + service/collab packages)

## Reference Files

Read these before making changes:
- `backend/internal/handler/collab_envelope.go` — to confirm it's unused
- `backend/internal/handler/collab_project_subscription.go` — to find symbols to relocate
- `backend/internal/handler/collab.go` — to find dead code
- `backend/internal/handler/collab_authenticator.go` — to find dead invalidation method
- `backend/internal/handler/collab_authenticator_test.go` — to find related dead tests
- `backend/internal/handler/collab_test.go` — to find dead test helpers
- `backend/internal/service/collab/subscription_service.go` — to confirm it's unused
- `backend/internal/domain/services/collab/collab.go` — to find dead domain interfaces
- `backend/cmd/server/main.go` — to verify wiring still works after changes
