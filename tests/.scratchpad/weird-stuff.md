# Weird Stuff & Gotchas

## Yjs state bootstrap requires WebSocket connection

Documents created via REST have `content` set but `yjs_state` is NULL. The Yjs state is only initialized when a WebSocket client first connects and subscribes — the session manager's `loadState()` bootstraps from the `content` column.

**Implication:** Any feature that reads `yjs_state` (snapshots, restore) returns empty data for documents that have never had a WS connection. The snapshot smoke test works around this by running a WS handshake probe before creating snapshots.

## FORBIDDEN vs DOCUMENT_NOT_FOUND for non-existent docs

When subscribing to a document that doesn't exist, the server returns `FORBIDDEN` (not `DOCUMENT_NOT_FOUND`). This is the secure pattern — it doesn't reveal whether the resource exists. The `doc:error` response has `code: "FORBIDDEN"`.

## Handshake probe `--expect` values

The handshake probe (`tests/smoke/collab/handshake/probe.go`) supports these modes:
- `AUTH_FAILED` — expects connection-level error after sending invalid JWT
- `FORBIDDEN` — expects `doc:error` with code FORBIDDEN after subscribing
- `DOCUMENT_NOT_FOUND` — expects `doc:error` with code DOCUMENT_NOT_FOUND (not used in current tests)
- `SYNC_OK` — full handshake: auth → subscribe → sync-step1 → proposal:snapshot → doc:subscribed → send sync-step2

## Mixed text/binary WebSocket frames

The WS protocol uses both JSON (text) and binary frames on the same connection. The server discriminates by checking if the first byte is `{` (0x7B). Binary frames use a 17-byte envelope header: 1 byte type + 16 bytes raw UUID.

## Worktree-aware port allocation

Backend port = `8080 + hash(directory_name) % 100`. Individual smoke scripts must source `scripts/dev/lib.sh` to get the correct port. The `helpers.sh` now does this, but if you're debugging manually, always check `source scripts/dev/lib.sh && echo $BACKEND_PORT`.

## Go probe compilation

Probes must be compiled from the `backend/` directory (or with `GOWORK=off`) to resolve the `y-crdt` dependency. Pattern:
```bash
cd "$ROOT_DIR/backend"
GOWORK=off GOCACHE="$(pwd)/.gocache" go run "$ROOT_DIR/tests/smoke/collab/.../probe.go" --flags...
```

## `((var++))` under `set -e`

Bash arithmetic `((0++))` evaluates to `((0))` which is falsy → exit code 1. Under `set -e`, this kills the script. Use `var=$((var + 1))` instead.
