# Smoke Test Results — 2026-03-09

All 7 probes pass. Full green suite.

```
=============================
[smoke] passed:  7
[smoke] failed:  0
[smoke] skipped: 0
=============================
```

## Probes

| Probe | Status | Type | Checks |
|---|---|---|---|
| collab/handshake | PASS | Go + bash | AUTH_FAILED, FORBIDDEN (non-existent doc), SYNC_OK |
| collab/sync | PASS | Go + bash | Initial sync, append text, reconnect verify, REST persistence |
| collab/proposals | PASS | Go + bash | Empty snapshot, accept-not-found, reject-not-found, accept-not-subscribed |
| collab/snapshots | PASS | Bash only | Create, list, get content, update doc, restore, verify, delete |
| collab/persistence | PASS | Go + bash | Debounce (5 rapid chars), disconnect-flush, round-trip reconnect |
| documents | PASS | Bash only | Create, get, PATCH update, list (project tree), delete, verify 404 |
| projects | PASS | Bash only | Create, get, PATCH update, list, delete, verify 404 |

## Backend Bugs Fixed

1. **Project PATCH validation** — `*string` type assertion fail → dereference before `validation.Validate`
2. **Snapshot restore** — content column set empty → extract from Yjs state via `decodeSnapshotContent`
3. **run.sh arithmetic** — `((0++))` under `set -e` → use `$((var + 1))` instead
