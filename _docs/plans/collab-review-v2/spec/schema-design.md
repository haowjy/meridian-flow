---
detail: standard
audience: developer, architect
---
# Schema Design

## Overview

Database schema stays minimal. Review decision state is stored in canonical Yjs (`_review_status`) and mirrored to proposal rows.

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

Backend mirrors `status` from `_review_status` map updates, keyed by `proposalId`.
Thread undo/redo updates proposal `status` between `accepted` and `reverted` directly.

### `${TABLE_PREFIX}documents`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PRIMARY KEY` | Document key |
| `yjs_state` | `BYTEA NOT NULL` | Canonical Yjs state |
| `content` | `TEXT` | Plain-text cache |

`ai_content` is removed.

### `${TABLE_PREFIX}idempotency_keys`

Unchanged request-idempotency table.

## Yjs Review State Shape

`_review_status` lives inside canonical Y.Doc:

- key: `proposalId`
- value: status string (`accepted`, `rejected`, `stale`)

Pending proposals are represented by missing keys plus proposal row `status = 'pending'`.

## Proposal Status Matrix

| Status | Meaning | Undo/Redo? |
|--------|---------|-----------|
| `pending` | Waiting for review | N/A |
| `accepted` | User explicitly accepted | Yes (thread undo) |
| `rejected` | User explicitly rejected | Yes (session Ctrl-Z while still in stack) |
| `stale` | Auto-resolved, canonical diverged and no diff remains | No |
| `reverted` | Accepted then thread-undone | Yes (thread redo) |

## What Was Eliminated

| Eliminated | Reason |
|---|---|
| `documents.ai_content` | Derived on demand from projection |
| Backend hunk tables | Hunks are frontend-only ephemeral view data |
| One-proposal-to-one-hunk identity | Hunks are grouped regions with proposal sets |
| Legacy proposal grouping linkage columns | Grouped hunks are derived dynamically from projection diff regions |
| Separate review-edit proposal status | Edit is plain user typing after reject or after accept |
| Separate review decision persistence stores | Canonical `_review_status` already persists via Yjs |

## Cross-References

- [Architecture](architecture.md)
- [Dual-Version Yjs Model](dual-version-yjs-model.md)
- [Review Undo Design](review-undo-design.md)
- [Thread-Level Undo](thread-level-undo.md)
- [Implementation Plan](plan.md)
