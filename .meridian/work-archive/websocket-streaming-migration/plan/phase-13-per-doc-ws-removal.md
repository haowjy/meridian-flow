# Phase 13: Per-Document Yjs WS Removal

## Scope

Remove the per-document Yjs WebSocket handler, endpoint, and all supporting code now that document sync is handled by the doc WS stream lane. This is a deletion phase — the new path (Phases 11-12) is proven, the old path can be removed.

## Design Reference

- [overview.md](../design/overview.md) §What Gets Removed — lists per-document WS items
- [doc-ws.md](../design/doc-ws.md) §What Gets Replaced — mapping table

## What's In Scope

1. Delete `collab_document_handler.go` (the per-document Yjs WS handler)
2. Delete `collab_document_handler_broadcast_test.go` (tests for the old handler)
3. Remove `GET /ws/documents/{documentId}` route from `collab.go`
4. Remove `CollabDocumentHandler` from `CollabModule` struct and construction
5. Remove old `DocumentBroadcaster` interface file (`collab_document_broadcaster.go`) — already replaced by `DocumentSyncBroadcaster` in Phase 11
6. Remove frontend `buildDocumentWsUrl()` helper if it exists
7. Remove any remaining per-document WS connection code from frontend
8. Clean up any callers that still reference `CollabDocumentHandler` directly

## What's Out of Scope

- SSE cleanup (already done in Phase 10)
- Any doc WS handler changes (done in Phase 11)
- Any frontend `DocStreamClient` changes (done in Phase 12)

## Prerequisites

- Phase 11 (Backend DocHandler with Yjs support is working)
- Phase 12 (Frontend DocStreamClient + DocumentWsProvider rewrite is working — no frontend code uses per-document WS anymore)

## Files to Delete

### Backend

| File | Reason |
|------|--------|
| `backend/internal/handler/collab_document_handler.go` | Per-document Yjs WS handler — replaced by DocHandler stream lane |
| `backend/internal/handler/collab_document_handler_broadcast_test.go` | Tests for deleted handler |
| `backend/internal/handler/collab_document_broadcaster.go` | Old `DocumentBroadcaster` interface — replaced by `DocumentSyncBroadcaster` in Phase 11. May already be updated/deleted in Phase 11; verify. |

### Frontend

| File/Code | Reason |
|-----------|--------|
| Per-document WS URL construction (if any `buildDocumentWsUrl` or similar helpers exist) | No longer needed |
| Direct binary frame handling code removed from `document-ws-provider.ts` | Already rewritten in Phase 12, but verify no remnants |

## Files to Modify

### `backend/internal/app/domains/collab.go`

- Remove `CollabDocumentHandler` construction:
  ```go
  // DELETE:
  collabDocumentHandler := handler.NewCollabDocumentHandler(
      collabSessionManager, infra.JWTVerifier, collabDocResolver, infra.Logger, cfg,
  )
  ```
- Remove `DocumentHandler` field from `CollabModule` struct
- Remove `GET /ws/documents/{documentId}` route:
  ```go
  // DELETE:
  mux.HandleFunc("GET /ws/documents/{documentId}", m.DocumentHandler.ConnectDocument)
  ```
- Remove `collabDocumentHandler` from all places it's passed as a constructor argument. After Phase 11, these should already pass `docHandler` instead. Verify no remaining references.
- Update `collab_message_loop.go` — evaluate if still needed. If only used by the old per-document WS handler, delete it. If used by other code paths, keep.

### `backend/internal/handler/collab.go` (shared types/helpers)

- Remove any per-document WS helpers (`addDocPrefix`, `encodeSyncUpdatePayload`, `docWSPrefix*` constants) — **but only if** these are no longer used by `DocHandler`. The DocHandler likely reuses these helpers. Grep before deleting.

### `backend/internal/handler/collab_proposal_broadcaster.go`

- Verify no references to old `DocumentBroadcaster` or `CollabDocumentHandler` remain. After Phase 11 this should use `DocumentSyncBroadcaster` / `DocHandler`.

## Cleanup Verification

Before deleting, verify no remaining references:

```bash
# Backend
grep -r "CollabDocumentHandler\|collab_document_handler" backend/ --include='*.go'
grep -r "DocumentBroadcaster[^S]" backend/ --include='*.go'  # exclude DocumentSyncBroadcaster
grep -r "ConnectDocument\|/ws/documents/" backend/ --include='*.go'
grep -r "HasOwnerTabs\|OwnerTabPresenceTracker" backend/ --include='*.go'

# Frontend
grep -r "buildDocumentWsUrl\|/ws/documents/" frontend-v2/src/
```

## Patterns to Follow

- Phase 10 cleanup approach: verify with grep, delete confidently, verify build passes
- Keep shared helpers (`collab.go`) if DocHandler still uses them

## Verification Criteria

- [ ] `go build ./backend/...` passes
- [ ] `go vet ./backend/...` passes
- [ ] `go test ./backend/...` passes
- [ ] `pnpm run lint` passes
- [ ] `pnpm tsc --noEmit` passes
- [ ] No `CollabDocumentHandler` references remain in codebase (grep)
- [ ] No `/ws/documents/{documentId}` route or references remain (grep)
- [ ] No `DocumentBroadcaster` (old interface) references remain (grep)
- [ ] Doc WS stream lane still works end-to-end (subscribe, sync, fanout)
- [ ] Doc WS notify lane still works (proposal/document invalidation)
- [ ] Thread WS still works (no regressions from collab module changes)

## Agent Staffing

- **Implementer**: `coder` — deletion-heavy, straightforward after Phases 11-12 are proven
- **Reviewers**: 1x completeness review (focus: no dead imports, no orphaned references, shared helpers correctly retained)
- **Testing**: `smoke-tester` (end-to-end: edit document → sync to second tab → proposal accept → Yjs update broadcast → all via doc WS)
- **Verification**: `verifier`
