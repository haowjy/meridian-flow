---
detail: standard
audience: developer, architect
---
# Collaboration Spec: Storage Model

**Status:** Draft  
**Purpose:** Define canonical persistence model and invariants for collaboration.

## Canonical Invariants

- Two streams are mandatory:
  - User stream (authoritative): human edits + accepted AI edits.
  - AI/agent stream (non-authoritative): proposal queue only.
- Document head version is monotonic and allocated only in user stream.
- On accept: promote proposal into authoritative user op, then remove proposal row.
- Once promoted, accepted AI ops are first-class user-stream history and follow the same compaction policy as human ops.
- Accept promotion is idempotent: one proposal can map to at most one authoritative operation.
- Authoritative `ai_accepted` provenance is immutable audit data and must not depend on mutable foreign-key targets.

## SQL Prefix Convention (Required)

1. Environment prefix comes from `MERIDIAN_SQL_PREFIX` (for example: `dev_`, `stg_`, `prd_`).
2. Tables: `<env_prefix>collab_document_applied_operations`, `<env_prefix>collab_document_edit_proposals`, `<env_prefix>collab_ws_tickets`.
3. Indexes/constraints: `<env_prefix>idx_collab_*`, `<env_prefix>uq_collab_*`, `<env_prefix>fk_collab_*` when explicitly named.
4. Shared-table columns added by collab must use `collab_` prefix (stable across envs).
5. New migration files should include `collab` in filename for ownership clarity.

## User Stream Schema (Authoritative)

```sql
CREATE TABLE <env_prefix>collab_document_applied_operations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version       INT NOT NULL,
    user_id       TEXT NOT NULL,
    origin        TEXT NOT NULL
                  CHECK (origin IN ('user', 'ai_accepted')),
    source_proposal_id UUID,
    producer_agent_type TEXT,
    thread_id     UUID,             -- denormalized provenance (no FK; must survive thread/turn cleanup)
    turn_id       UUID,             -- denormalized provenance (no FK; must survive thread/turn cleanup)
    agent_run_id  UUID,
    client_id     TEXT NOT NULL,
    client_op_id  TEXT NOT NULL,
    changeset     JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(document_id, version),
    UNIQUE(document_id, client_id, client_op_id),
    CHECK (
      (origin = 'user'
        AND source_proposal_id IS NULL
        AND producer_agent_type IS NULL
        AND thread_id IS NULL
        AND turn_id IS NULL
        AND agent_run_id IS NULL)
      OR
      (origin = 'ai_accepted'
        AND source_proposal_id IS NOT NULL
        AND producer_agent_type IS NOT NULL
        AND thread_id IS NOT NULL
        AND agent_run_id IS NOT NULL)
    )
);

CREATE INDEX <env_prefix>idx_collab_document_applied_doc_version
    ON <env_prefix>collab_document_applied_operations(document_id, version);

CREATE INDEX <env_prefix>idx_collab_applied_origin_created
    ON <env_prefix>collab_document_applied_operations(origin, created_at DESC);

CREATE INDEX <env_prefix>idx_collab_applied_doc_origin_created
    ON <env_prefix>collab_document_applied_operations(document_id, origin, created_at DESC);

CREATE UNIQUE INDEX <env_prefix>uq_collab_applied_source_proposal
    ON <env_prefix>collab_document_applied_operations(source_proposal_id)
    WHERE source_proposal_id IS NOT NULL;
```

## AI/Agent Stream Schema (Proposal Queue)

```sql
CREATE TABLE <env_prefix>collab_document_edit_proposals (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id           UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    source                TEXT NOT NULL DEFAULT 'ai',
    producer_agent_type   TEXT NOT NULL,
    thread_id             UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    turn_id               UUID REFERENCES turns(id) ON DELETE SET NULL,
    agent_run_id          UUID NOT NULL,
    proposal_group_id     UUID,
    status                TEXT NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed', 'rejected', 'conflicted')),
    base_version          INT NOT NULL,
    anchor_start          INT NOT NULL,
    anchor_end            INT NOT NULL,
    before_hash           TEXT NOT NULL,
    changeset             JSONB NOT NULL,
    description           TEXT,
    created_by_user_id    TEXT NOT NULL,
    decided_by_user_id    TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at            TIMESTAMPTZ
);
```

## Proposal Query Indexes (Required)

```sql
CREATE INDEX <env_prefix>idx_collab_proposal_doc_status_created
    ON <env_prefix>collab_document_edit_proposals(document_id, status, created_at DESC);

CREATE INDEX <env_prefix>idx_collab_proposal_group_status
    ON <env_prefix>collab_document_edit_proposals(proposal_group_id, status);

CREATE INDEX <env_prefix>idx_collab_proposal_status_created
    ON <env_prefix>collab_document_edit_proposals(status, created_at DESC);

CREATE INDEX <env_prefix>idx_collab_proposal_thread_turn
    ON <env_prefix>collab_document_edit_proposals(thread_id, turn_id, created_at DESC);
```

## Producer Identity and Provenance

- `thread_id` is required execution context.
- `turn_id` links creation to one turn/tool event.
- `agent_run_id` is required for run-level traceability.
- `producer_agent_type` is required for filtering and analytics.
- (`thread_id`, `agent_run_id`, `id`) must trace each AI change end-to-end.
- On accept, proposal provenance is copied into user stream and remains queryable after proposal-row removal.
- Required copied provenance for `origin='ai_accepted'`: `source_proposal_id`, `producer_agent_type`, `thread_id`, `turn_id` (when available), `agent_run_id`.

## Snapshot Metadata

```sql
ALTER TABLE documents
  ADD COLUMN collab_snapshot_version INT NOT NULL DEFAULT 0,
  ADD COLUMN collab_op_floor_version INT NOT NULL DEFAULT 0;
```

## Compaction Segment Metadata (Required for Tiered Compaction)

```sql
CREATE TABLE <env_prefix>collab_document_compacted_segments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    from_version      INT NOT NULL,
    to_version        INT NOT NULL,
    entry_count       INT NOT NULL,
    composed_changeset JSONB NOT NULL,
    origins           TEXT[] NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (from_version <= to_version),
    UNIQUE(document_id, from_version, to_version)
);

CREATE INDEX <env_prefix>idx_collab_compacted_doc_to_version
    ON <env_prefix>collab_document_compacted_segments(document_id, to_version DESC);
```

```sql
CREATE TABLE <env_prefix>collab_document_proposal_rollups (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id        UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    bucket_start       TIMESTAMPTZ NOT NULL,
    bucket_end         TIMESTAMPTZ NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('rejected', 'conflicted')),
    producer_agent_type TEXT,
    proposal_count     INT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (bucket_start < bucket_end)
);

CREATE INDEX <env_prefix>idx_collab_proposal_rollups_doc_bucket
    ON <env_prefix>collab_document_proposal_rollups(document_id, bucket_end DESC);
```

## WS Ticket Schema

```sql
CREATE TABLE <env_prefix>collab_ws_tickets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT NOT NULL,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Version Allocation

`SELECT ... FOR UPDATE` row lock on `documents`, then assign the next version in user stream.

- User edits allocate versions with `origin='user'`.
- Accepted proposals allocate versions with `origin='ai_accepted'`.
- Proposal stream has no authoritative versions.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/compaction-retention.md`
