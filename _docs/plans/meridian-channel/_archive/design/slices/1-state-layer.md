# Slice 1: State Layer (SQLite + Events + Traces)

**Required reading:**
- [`_docs/plans/meridian-channel/README.md`](../README.md) (always)
- [`_docs/plans/meridian-channel/design-philosophy.md`](../design-philosophy.md) (always)
- [`_docs/plans/meridian-channel/architecture.md`](../architecture.md) (storage protocols, project layout)

**Effort:** 2 days
**Dependencies:** Slice 0 (package must install).
**Model recommendation:** `gpt-5.3-codex`

## Description

Implement the SQLite state database with WAL mode, event-sourced workflow state, trace spans, and workspace/context-pinning tables. Maintain JSONL dual-write for backwards compatibility. Fixes critical gaps #2 (lock mismatch) and #5 (index corruption).

## Required reading (`-f` files for orchestrator)

- `_docs/plans/meridian-channel/README.md`
- `_docs/plans/meridian-channel/architecture.md`
- `.claude/skills/run-agent/scripts/lib/logging.sh` (current JSONL index write logic)
- `.claude/skills/run-agent/scripts/run-index.sh` (current index query/maintain logic)

## Files to create

- `src/meridian/lib/state/__init__.py` — public API
- `src/meridian/lib/state/db.py` — SQLite connection, WAL config, busy_timeout
- `src/meridian/lib/state/schema.py` — table definitions + migrations
- `src/meridian/lib/adapters/sqlite.py` — sync + async SQLite implementations of Storage Protocols
- `src/meridian/lib/state/jsonl.py` — JSONL reader/writer for dual-write + import
- `src/meridian/lib/state/id_gen.py` — counter-based ID generation
- `src/meridian/lib/state/artifact_store.py` — ArtifactStore Protocol + LocalStore + InMemoryStore

## SQLite schema

Same schema as the Rust plan (all 8 tables: `runs`, `workspaces`, `pinned_files`, `workflow_events`, `spans`, `run_edges`, `artifacts`, `schema_info`). Key points:

- WAL mode enabled, `busy_timeout` set to 5000ms
- All IDs use domain newtypes
- `workspace_id` nullable in `runs` (standalone runs have NULL)
- All paths stored as relative, resolved to absolute on read
- Migrations are embedded Python functions, forward-only, versioned
- **Nullable-first migration policy** (restored from Rust plan): new columns are always nullable; never require backfill in migration. Backfill is a separate step that can fail independently.

## ArtifactStore Protocol

```python
from typing import Protocol

class ArtifactStore(Protocol):
    def put(self, key: ArtifactKey, data: bytes) -> None: ...
    def get(self, key: ArtifactKey) -> bytes: ...
    def exists(self, key: ArtifactKey) -> bool: ...
    def delete(self, key: ArtifactKey) -> None: ...
    def list_artifacts(self, run_id: str) -> list[ArtifactKey]: ...
```

## Locking strategy

- SQLite WAL mode handles concurrent access natively
- File lock (`.meridian/index/runs.lock`) via `fcntl.flock` for JSONL dual-write
- Writers: exclusive lock. Readers: shared lock.

## Directory layout

```
.meridian/
  config.toml
  models.toml
  index/
    runs.db                    # SQLite WAL database
  runs/                        # standalone runs
    r1/
      params.json, input.md, output.jsonl, report.md
  workspaces/                  # workspace-bound runs
    w3/
      workspace-summary.md
      runs/
        r1/
          params.json, input.md, output.jsonl, report.md
  active-workspaces/           # PID lock files
    w3.lock
```

## Acceptance criteria

1. SQLite DB created at `.meridian/index/runs.db` with WAL mode enabled
2. `busy_timeout` set to 5000ms
3. Schema includes all 8 tables
4. Schema migrations run automatically on first access (embedded, versioned, forward-only)
5. `append_start_row()` writes to both SQLite and JSONL atomically under lock
6. `append_finalize_row()` updates SQLite row and appends JSONL under lock
7. Run ID generation supports both workspace-scoped and global counters
8. `ArtifactStore` Protocol defined with `LocalStore` and `InMemoryStore` implementations
9. All domain types are frozen dataclasses using domain newtypes
10. Unit tests for: schema creation, CRUD, events, spans, locking contention, JSONL round-trip, artifact store
