---
detail: minimal
audience: developer
---
# ws-transport-v2 Handler Test Coverage

**Status:** in-progress

## Goal

Add targeted backend handler unit tests for the ws-transport-v2 changes so the remaining behavior paths and failure branches are exercised before further refactors.

## Scope

- `ProjectConnectionRegistry`
  - Register/unregister replacement and nil handling
  - Broadcast routing and empty-target behavior
  - Concurrent register/unregister/broadcast safety
- Project websocket auth and per-connection document access cache
  - Auth bootstrap edge cases
  - Cache miss failure paths and cache isolation per connection
- Proposal commands
  - Validation failures
  - Access-denied and resolver error paths
  - `proposal:requestUpdate` store and ownership errors
- Document handler broadcast/cache behavior
  - Fanout skips sender
  - Unregister cleanup and missing-document no-op

## Verification

- `cd backend && go test ./internal/handler/... -count=1 -timeout 60s -v`
- `cd backend && go vet ./internal/handler/...`
