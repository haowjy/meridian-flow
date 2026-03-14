---
detail: standard
audience: developer, architect
---
# Schema Design

## Overview

Database schema stays minimal. Decision state lives in Yjs (`_proposal_status`) and is mirrored to proposal rows for querying.

```mermaid
erDiagram
    documents ||--o{ proposals : has
    documents ||--o{ document_updates : has
    documents ||--o{ document_checkpoints : has
    documents ||--o{ document_bookmarks : has
    threads ||--o{ proposals : owns

    documents {
        UUID id PK
        BYTEA yjs_state
        TEXT content
    }
    proposals {
        UUID id PK
        UUID document_id FK
        UUID thread_id FK
        TEXT status
        BYTEA yjs_update
        TEXT region_text_before
        TEXT region_text_after
    }
    document_updates {
        BIGSERIAL id PK
        UUID doc_id FK
        BYTEA update
        TEXT origin
    }
    document_checkpoints {
        BIGSERIAL id PK
        UUID doc_id FK
        BYTEA state
        BIGINT up_to_id
    }
```

## Dual Authority: Y.Map + Proposal Rows

Decision state has two representations that stay in sync:

```mermaid
flowchart LR
    subgraph yjs ["Y.Doc (canonical, synced)"]
        M["Y.Map('_proposal_status')<br/>P1: accepted<br/>P3: rejected<br/>P4: stale"]
    end
    subgraph db ["Postgres (queryable)"]
        R["proposals table<br/>P1: accepted<br/>P2: pending<br/>P3: rejected<br/>P4: stale<br/>P5: reverted"]
    end
    M -->|"Yjs sync delta"| BE["Backend Mirror"]
    BE -->|"upsert status"| R
    TU["Thread Undo/Reapply"] -->|"writes to Y.Map"| M
```

- `pending` = no Y.Map entry, proposal row exists with `status = 'pending'`
- `accepted`, `rejected`, `stale` = Y.Map entry, mirrored to row
- `reverted` = thread undo writes to Y.Map, mirrored to row
- `rejected -> accepted` = thread reapply writes to Y.Map, mirrored to row

## Implementation Notes

- Clean-slate schema: define `${TABLE_PREFIX}proposals` fresh with canonical names (`pending` status) and no legacy columns.

## Tables

### `${TABLE_PREFIX}proposals`

Stores proposal payload and lifecycle status.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PRIMARY KEY` | Proposal key |
| `document_id` | `UUID NOT NULL` | FK to `documents` |
| `thread_id` | `UUID NOT NULL` | Thread owner |
| `created_by_user_id` | `UUID NOT NULL` | User who initiated the AI proposal request |
| `status` | `TEXT NOT NULL` | `pending`, `accepted`, `rejected`, `stale`, `reverted` |
| `yjs_update` | `BYTEA NOT NULL` | Proposal payload |
| `region_text_before` | `TEXT NULL` | Captured at proposal creation from `edit_document` find text |
| `region_text_after` | `TEXT NULL` | Captured at proposal creation from `edit_document` replacement text |
| `created_at` | `TIMESTAMPTZ DEFAULT NOW()` | Created time |

Backend mirrors `status` from `_proposal_status` map updates, keyed by `proposalId`.
Thread undo/reapply also writes to `_proposal_status`, so all status changes flow through the same mirror path.

### `${TABLE_PREFIX}documents`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PRIMARY KEY` | Document key |
| `content` | `TEXT` | Plain-text cache |

`yjs_state` is removed — replaced by `document_updates` + `document_checkpoints` (see [Append-Only Persistence](append-only-persistence.md)).
`ai_content` is removed — derived on demand from projection.

### `${TABLE_PREFIX}idempotency_keys`

Unchanged request-idempotency table.

## Yjs Proposal State Shape

`_proposal_status` lives inside canonical Y.Doc:

- key: `proposalId`
- value: status string (`accepted`, `rejected`, `stale`, `reverted`)

Pending proposals are represented by missing keys plus proposal row `status = 'pending'`.

## Proposal Status Matrix

| Status | Meaning | Undo/Redo? |
|--------|---------|-----------|
| `pending` | Waiting for action | N/A |
| `accepted` | User explicitly accepted or auto-applied | Yes (thread undo) |
| `rejected` | User explicitly rejected | Session Ctrl-Z while in stack, or thread reapply |
| `stale` | Auto-resolved, canonical diverged and no diff remains | No |
| `reverted` | Accepted then thread-undone | Yes (thread reapply) |

## What Was Eliminated

| Eliminated | Reason |
|---|---|
| `documents.ai_content` | Derived on demand from projection |
| Backend hunk tables | Hunks are frontend-only ephemeral view data |
| One-proposal-to-one-hunk identity | Hunks are grouped regions with proposal sets |
| Legacy proposal grouping linkage columns | Grouped hunks are derived dynamically from projection diff regions |
| Separate review-edit proposal status | Edit is plain user typing after reject or after accept |
| Separate decision persistence stores | Canonical `_proposal_status` already persists via Yjs |

## Cross-References

- [Architecture](architecture.md)
- [Dual-Version Yjs Model](dual-version-yjs-model.md)
- [Session Undo Design](session-undo-design.md)
- [Thread-Level Undo](thread-level-undo.md)
- [Implementation Plan](plan.md)
