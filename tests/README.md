# Tests

Black-box and cross-cutting tests that exercise the system from the outside.

Package-level tests stay where they are:
- **Go unit/integration**: `backend/internal/.../*_test.go` (colocated, Go convention)
- **Vitest unit**: `frontend/tests/.../*.test.ts` (mock WS, no server needed)

This directory is for tests that need a running system or span both stacks.

## Structure

```
tests/
  helpers/          shared utilities (auth, WS client, fixture loader)
  smoke/            fast probes against running dev server
    collab/         WebSocket + binary envelope protocol
      handshake/    connection lifecycle, auth, heartbeat
      sync/         doc subscribe, SyncStep1/2, update roundtrip
      proposals/    AI proposal create/accept/reject
      snapshots/    snapshot CRUD, restore
      persistence/  debounce flush, crash recovery
    documents/      REST CRUD + search
    projects/       REST CRUD + tree + favorites
    threads/        create, stream (SSE), history
    auth/           JWT validation, token refresh
  e2e/              Playwright (needs frontend + backend running)
    collab/         multi-tab sync, offline, proposal review UI
  fixtures/         seed data (SQL, JSON, markdown)
  playbooks/        LLM-driven exploratory testing
    collab/         markdown instructions for agent probing
```

## Running

```bash
# Smoke tests (requires running dev server)
./scripts/get-token.sh                    # refresh JWT
go test ./tests/smoke/... -tags=smoke     # all smoke tests
go test ./tests/smoke/collab/... -tags=smoke  # collab only

# Playwright E2E (requires frontend + backend running)
npx playwright test --config tests/e2e/playwright.config.ts

# Individual Go probe (legacy pattern, migrating here)
go run tests/smoke/collab/handshake/probe.go
```

## Conventions

- **Go smoke tests** use `//go:build smoke` tag so `go test ./...` skips them by default
- **Each test creates its own fixtures** via REST API, cleans up on exit
- **Auth**: use `helpers.GetToken()` which reads `ACCESS_TOKEN` from root `.env`
- **WS client**: use `helpers.DialProject()` which handles JWT auth + `project:connected` ack
- **Assertions**: `testify/require` for Go, Playwright `expect` for E2E

## Writing a New Smoke Test

1. Pick the right subdirectory under `smoke/`
2. Add `//go:build smoke` at the top
3. Use helpers for auth + WS dialing
4. Create temp resources, test, clean up (idempotent)
5. Run with `go test -tags=smoke ./tests/smoke/collab/sync/...`
