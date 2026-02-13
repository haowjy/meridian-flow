---
detail: standard
audience: developer, architect
---
# Collaboration Spec: Compaction and Retention

**Status:** Draft  
**Purpose:** Define safety constraints for snapshot compaction and data retention.

## Runtime Config (Env Vars, Required)

| Variable | Default | Bounds / Validation | Purpose |
|---|---|---|---|
| `MERIDIAN_COLLAB_COMPACTION_OP_COUNT_THRESHOLD` | `200` | `>= 50` | Trigger compaction when raw authoritative op count exceeds threshold. |
| `MERIDIAN_COLLAB_COMPACTION_OP_BYTES_THRESHOLD` | `262144` | `>= 65536` | Trigger compaction when raw authoritative op bytes exceed threshold. |
| `MERIDIAN_COLLAB_COMPACTION_MAX_AGE_HOURS` | `24` | `>= 1` | Trigger compaction when a document has not compacted recently. |
| `MERIDIAN_COLLAB_REPLAY_TAIL_OPS` | `75` | `>= 20` | Keep recent raw ops for reconnect and persistent undo continuity. |
| `MERIDIAN_COLLAB_PROPOSAL_HOT_DAYS` | `30` | `>= 7` | Keep `rejected/conflicted` proposals as raw rows before rollup tiers. |
| `MERIDIAN_COLLAB_PROPOSAL_DAILY_TO_WEEKLY_DAYS` | `90` | `> MERIDIAN_COLLAB_PROPOSAL_HOT_DAYS` | Upper bound of daily rollup tier. |
| `MERIDIAN_COLLAB_PROPOSAL_WEEKLY_TO_MONTHLY_DAYS` | `365` | `> MERIDIAN_COLLAB_PROPOSAL_DAILY_TO_WEEKLY_DAYS` | Upper bound of weekly rollup tier. |
| `MERIDIAN_COLLAB_COMPACTION_LOCK_TIMEOUT_MS` | `2000` | `>= 250` | SQL `lock_timeout` for compaction transactions. |
| `MERIDIAN_COLLAB_COMPACTION_STATEMENT_TIMEOUT_MS` | `5000` | `> MERIDIAN_COLLAB_COMPACTION_LOCK_TIMEOUT_MS` | SQL `statement_timeout` for compaction transactions. |

Startup must fail fast on invalid values.

## Execution Model (Graphile Worker, Required)

1. Compaction runs in Graphile Worker jobs backed by PostgreSQL.
2. Write/apply/accept request paths never run compaction inline.
3. On new authoritative op or proposal-state transition, server enqueues background jobs only:
   - `compact-document` with `job_key=compact-document:{document_id}`
   - `rollup-proposals` with `job_key=rollup-proposals:{document_id}`
4. `job_key` is required for per-document dedupe/debounce during bursty edits.
5. Worker must acquire a per-document advisory lock before processing (`pg_try_advisory_xact_lock`), and skip when lock is unavailable.
6. Jobs are idempotent and retry-safe; retries must not create duplicate compacted segments/rollups.
7. Scheduler still runs periodic sweep jobs (daily/weekly/monthly tiers) to heal missed enqueues and stale backlog.

## Retention and Cleanup (v1)

1. `<env_prefix>collab_ws_tickets`:
   - Delete rows where `expires_at < now() - interval '1 day'` every hour.
2. `<env_prefix>collab_document_edit_proposals` (AI/agent stream):
   - `proposed` rows remain raw queue items (never compact while pending).
   - Accepted proposals are removed immediately during accept transaction.
   - `rejected`/`conflicted` rows use tiered/logarithmic compaction:
     - raw hot window: keep `MERIDIAN_COLLAB_PROPOSAL_HOT_DAYS` days
     - rollup tiers: daily (`MERIDIAN_COLLAB_PROPOSAL_HOT_DAYS + 1` to `MERIDIAN_COLLAB_PROPOSAL_DAILY_TO_WEEKLY_DAYS`), weekly (`MERIDIAN_COLLAB_PROPOSAL_DAILY_TO_WEEKLY_DAYS + 1` to `MERIDIAN_COLLAB_PROPOSAL_WEEKLY_TO_MONTHLY_DAYS`), monthly (`> MERIDIAN_COLLAB_PROPOSAL_WEEKLY_TO_MONTHLY_DAYS`)
   - Delete raw rows only after corresponding rollup rows are committed.
3. `<env_prefix>collab_document_applied_operations` (user stream):
   - Contains all authoritative edits.
   - Compaction treats `origin='user'` and `origin='ai_accepted'` identically.
   - Keep replay tail (`MERIDIAN_COLLAB_REPLAY_TAIL_OPS`) as raw operations for reconnect/undo continuity.
   - Older ops compact into version-range segments using logarithmic tiers so per-doc segment count converges.
   - Raw ops included in compacted segments may be deleted after segment + snapshot metadata commit.
4. Cleanup jobs run in Graphile Worker (single replica in v1; scalable later).

## Compaction Policy

1. Trigger compaction when any condition is met:
   - applied op count > `MERIDIAN_COLLAB_COMPACTION_OP_COUNT_THRESHOLD`
   - applied op bytes > `MERIDIAN_COLLAB_COMPACTION_OP_BYTES_THRESHOLD`
   - active document has not compacted in `MERIDIAN_COLLAB_COMPACTION_MAX_AGE_HOURS`
2. Compose authoritative user-stream ops up to `cutoff_version` with `ChangeSet.compose()`.
3. In one transaction:
   - write `documents.content` snapshot at `cutoff_version`
   - set `collab_snapshot_version = cutoff_version`
   - upsert compacted segment metadata for the compacted version range
   - delete eligible raw authoritative ops (both `user` and `ai_accepted`) from contiguous prefix `<= cutoff_version - MERIDIAN_COLLAB_REPLAY_TAIL_OPS`
   - set `collab_op_floor_version` to oldest contiguous replayable remaining version (or `collab_snapshot_version`)
4. Keep replay tail (`MERIDIAN_COLLAB_REPLAY_TAIL_OPS`) for reconnect and undo continuity.
5. Proposal-stream rollups run separately and never include `status='proposed'`.
6. Tier scheduler target:
   - daily pass for hot->daily rollups
   - weekly pass for daily->weekly rollups
   - monthly pass for weekly->monthly rollups

## Deletion Safety Rule

- Never create version holes in replayable range.
- Delete raw rows only after durable compacted representation exists.
- `/changesets` queryability must be preserved through merged reads (raw tail + compacted segments/rollups).

## Reconnect Contract

If client requests `fromVersion < collab_op_floor_version`, server returns `RESET_REQUIRED`.
Client reloads snapshot and reconnects from `collab_snapshot_version`.

## Compaction/Write Concurrency Rules

1. Fixed lock order: `documents` row lock first, then operation-range reads.
2. Use `lock_timeout = MERIDIAN_COLLAB_COMPACTION_LOCK_TIMEOUT_MS` and `statement_timeout = MERIDIAN_COLLAB_COMPACTION_STATEMENT_TIMEOUT_MS` for compaction transactions.
3. On lock timeout, abort compaction and retry later (no partial work).
4. At most one compaction job per document at a time (document mutex).
5. Apply path wins over compaction under contention.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/phase/phase-2-history-and-undo.md`
