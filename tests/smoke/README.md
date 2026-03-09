# Smoke Tests

Fast probes against a running dev server. Organized by feature.

## Probe Types

Smoke probes are small standalone scripts.

- WebSocket protocol probes use Go programs.
- REST CRUD probes use bash `smoke.sh` scripts built on `tests/smoke/helpers.sh`.

Run individually:
```bash
go run tests/smoke/collab/handshake/probe.go --url $WS_URL --token $TOKEN
bash tests/smoke/projects/smoke.sh
```

Run all via orchestrator:
```bash
bash tests/smoke/run.sh
```

## Directory Layout

```
smoke/
  run.sh              orchestrator (refreshes token, runs all probes)
  collab/             WebSocket + binary envelope
    handshake/        connect, auth, heartbeat, rate limit
    sync/             subscribe, SyncStep1/2, update roundtrip
    proposals/        create, accept, reject, group accept
    snapshots/        CRUD, restore
    persistence/      debounce flush, crash recovery
  documents/          REST CRUD + search
  projects/           REST CRUD + tree + favorites
  threads/            create, stream (SSE), history
  auth/               JWT validation, token refresh
```

## Adding a New Probe

1. Create either `tests/smoke/<feature>/probe.go` or `tests/smoke/<feature>/smoke.sh`
2. Reuse `tests/smoke/helpers.sh` for shell probes
3. Print `[smoke] PASS: <description>` or `[smoke] FAIL: <description>`
4. Exit 0 on pass, 1 on fail
5. Add to `run.sh` orchestrator
