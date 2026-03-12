# Phase 1B Handler Test Gaps (2026-03-11)

## Scope
Add backend unit tests for ws-transport-v2 Phase 1B coverage gaps in handler package:
- `ProjectConnectionRegistry` register/unregister/broadcast behavior, including nil entries and concurrent access patterns.
- Per-connection document access cache behavior on project WS proposal commands.
- `CollabDocumentHandler.BroadcastToDocument` fanout behavior and send-error resilience.

## Plan
1. Add `project_connection_registry_test.go` with targeted unit tests for project routing, unregister behavior, nil-safety, and concurrency stress.
2. Add project WS cache test that verifies first proposal command triggers document access checks and second command for same document on same connection reuses cache.
3. Add `collab_document_handler_broadcast_test.go` that spins lightweight websocket peers and verifies binary fanout + graceful handling when one target send fails.
4. Run verification:
   - `cd backend && go test ./internal/handler/... -count=1 -timeout 60s -v`
   - `cd backend && go vet ./internal/handler/...`

## Notes
- This is an additive test-only change.
- Task prompt is treated as plan approval for execution.
