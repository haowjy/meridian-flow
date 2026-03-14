# Phase 1B Test Fix: Update tests after subscription removal

You are fixing tests in `backend/internal/handler/` that broke after Phase 1B simplified the project WebSocket to JSON-only (removing all doc:subscribe, doc:unsubscribe, and binary frame handling).

## Context

Phase 1B removed the subscription protocol from the project WebSocket. Previously, clients had to `doc:subscribe` before sending proposal commands. Now, document access is validated inline via `checkDocumentAccess()` when a proposal command is received. The `handleProjectProposalCommand` function in `collab_project.go` validates access using a per-connection `documentAccessCache map[string]bool`.

## What needs to change

### 1. `collab_proposal_test.go` — Remove subscription dependency

The `subscribeDocOnProjectWS()` helper sends `doc:subscribe` and drains 3 response messages (binary sync-step1, proposal:snapshot, doc:subscribed). This no longer works because `doc:subscribe` is now an unknown message type that gets silently ignored.

**Fix:** Delete the `subscribeDocOnProjectWS()` helper entirely. Remove ALL calls to it from tests. Proposal commands now work directly after authentication — the access check happens automatically via `checkDocumentAccess` inside `handleProjectProposalCommand`.

Tests to update (remove `subscribeDocOnProjectWS` call):
- `TestProjectWS_ProposalAcceptDispatchAndBroadcast` (line 357)
- `TestProjectWS_ProposalGroupAcceptResultEvent` (line 452)
- `TestProjectWS_ProposalAcceptNonSubscribedDocument` (line 517)
- `TestProjectWS_ProposalRejectNonSubscribedDocument` (line 562)
- `TestProjectWS_ProposalAcceptErrorMapping_IdempotencyConflict` (line 606)
- `TestProjectWS_ProposalAcceptErrorMapping_RateLimited` (line 643)
- `TestProjectWS_ProposalRequestUpdate` (line 699)
- `TestProjectWS_ProposalRequestUpdateNotFound` (line 749)
- `TestProjectWS_ProposalRequestUpdateWrongDocument` (line 807)

### 2. `collab_proposal_test.go` — Delete `TestProjectWS_ProposalSnapshotAfterSubscribe`

This test (line 221) tests the proposal:snapshot sent during the doc:subscribe handshake. That handshake no longer exists. Delete the entire test.

### 3. `collab_proposal_test.go` — Fix "non-subscribed" tests

These tests previously checked that operations on non-subscribed documents returned `NOT_SUBSCRIBED`. The subscription concept is gone — access is now via `checkDocumentAccess`.

**`TestProjectWS_ProposalAcceptNonSubscribedDocument`:**
- The test sends proposal:accept WITHOUT a documentId field. In Phase 1B, an empty documentId fails UUID validation (line 166 of collab_project.go). The error is `INTERNAL_ERROR` with message "documentId must be a valid UUID".
- Update the test to expect an error response. The error comes back as a `doc:error` with code `INTERNAL_ERROR`.
- Actually, since documentId is empty string, `parseUUID("")` will fail, and `sendError` is called (not `sendDocError`). Check how `sendError` formats the response — it sends `{"type":"error","code":"INTERNAL_ERROR","message":"documentId must be a valid UUID"}`.
- Update: the test should expect `type: "error"`, `code: "INTERNAL_ERROR"`. Use `readWSErrorMessage` helper (returns wsErrorMessage with Code/Message fields).

**`TestProjectWS_ProposalRejectNonSubscribedDocument`:**
- This test sends proposal:reject with a different documentId. In Phase 1B, the access check happens via `checkDocumentAccess`. The resolver allows access (test resolver has `allowed: true`). So the reject command would actually succeed (be dispatched to the proposal service).
- Rework this test: instead of testing "non-subscribed" (which no longer exists), test "access denied" — set `resolver.allowed = false` for the test, send a proposal:reject, and expect `doc:error` with code `FORBIDDEN`.
- OR simply delete both "non-subscribed" tests since their premise (subscription validation) is gone and the new access control is already tested in the authenticator unit tests.
- **Decision: delete both tests.** The access control path is tested by `TestAuthenticator_CheckDocumentAccess_*` tests. Testing missing documentId (UUID validation) can be a separate small test.

### 4. `collab_proposal_test.go` — Fix `ProposalAcceptDispatchAndBroadcast` broadcast assertions

This test expects to RECEIVE broadcast messages on the same connection after sending proposal:accept. In Phase 1B:
- Yjs updates go to `docHandler.BroadcastToDocument()` → document WS connections (not project WS)
- JSON status events go to `projectRegistry.BroadcastToProject()` → project WS connections

The test server creates a `projectRegistry` and passes it to `NewCollabHandler`. The test's connection IS registered in the project registry (Phase 1B registers on auth success). So the JSON `proposal:statusChanged` event should be received.

But the binary Yjs update will NOT arrive on the project WS anymore — it goes to the document WS handler (`docHandler`), which is `nil` in tests.

**Fix:** Remove the binary message assertion from this test (lines 369-382 that read and check the binary update envelope). Only keep the JSON `proposal:statusChanged` assertion.

Also, the test reads messages in order: first binary, then JSON. Since binary won't come, update to read JSON directly.

### 5. `collab_proposal_test.go` — Fix `ProposalGroupAcceptResultEvent`

This test sends `proposal:groupAccept` and reads the result event. The group accept result is broadcast via `projectRegistry.BroadcastToProject()` (JSON). The test connection is registered in the project registry. So this test should work WITHOUT the `subscribeDocOnProjectWS` call. Just remove that call.

### 6. Clean up unused imports and helpers

After all changes:
- Delete `subscribeDocOnProjectWS` helper
- Delete `readWSBinaryMessage` helper if no longer used (check both test files)
- Remove unused imports: anything from `collab_project_subscription.go` types, any unused packages
- The `testCollabStore` usage — check if it's still needed. If the store is only used for subscription-related tests that are deleted, remove it.

### 7. Add test for missing documentId on proposal command

Add a small test `TestProjectWS_ProposalAcceptMissingDocumentID` that:
- Authenticates
- Sends proposal:accept without documentId
- Expects error with code INTERNAL_ERROR

### 8. Add test for document access denied on proposal command

Add a small test `TestProjectWS_ProposalAcceptAccessDenied` that:
- Sets up resolver with `allowed: false`
- Authenticates
- Sends proposal:accept with valid documentId
- Expects doc:error with code FORBIDDEN

## Important

- Read both test files fully before making changes
- Read `collab_project.go` to understand the current message flow
- Read `collab_authenticator.go` to understand `checkDocumentAccess` return values
- `go vet ./...` must pass
- `go build ./...` must pass
- `go test ./internal/handler/... -count=1 -timeout 60s` must pass
- Run `gofmt -w` on modified files

## Reference files

- `backend/internal/handler/collab_project.go` — current message handling
- `backend/internal/handler/collab_project_test.go` — project WS tests (mostly fine)
- `backend/internal/handler/collab_proposal_test.go` — proposal tests (main file to fix)
- `backend/internal/handler/collab_proposal.go` — proposal handlers
- `backend/internal/handler/collab_authenticator.go` — checkDocumentAccess
- `backend/internal/handler/collab.go` — CollabHandler struct and NewCollabHandler
