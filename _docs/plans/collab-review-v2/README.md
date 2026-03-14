---
detail: standard
audience: developer, architect
---
# Collab Review v2: Projection + Review Status Map

**Status:** draft

## Why

The v1 review design added complexity that did not improve writer workflow: legacy text-derived hunk identity, extra review-state indirection, and delayed resolution semantics. v2 simplifies to one canonical Y.Doc and immediate, undoable actions.

## Core Model

- Proposal rows store `yjs_update` as pending change payloads.
- Diff display is ephemeral:
  - clone canonical
  - apply each `pending` proposal update while tracking which proposals affect which regions
  - diff projection vs canonical into raw hunks
  - group nearby or overlapping raw hunks into user-facing hunk regions
  - discard projection
- `_review_status` is a `Y.Map` on canonical:
  - key: `proposalId`
  - value: `accepted | rejected | stale`
- Actions are immediate:
  - Accept hunk: apply all grouped hunk proposal updates to canonical and set `_review_status` to `accepted` for every contributing proposal in one transaction.
  - Reject hunk: set `_review_status` to `rejected` for every contributing proposal in one transaction.
  - Edit hunk: user rejects then types, or accepts then modifies; edits are normal `ORIGIN_HUMAN` typing.
- Hunk identity is a grouped text region with one or more contributing proposals.
- Projection GC auto-resolves stale proposals:
  - if applying a pending proposal yields no remaining diff, set its status to `stale`
  - stale proposals never render as hunks and show as "No longer relevant" in thread UI
- UndoManager scopes `Y.Text('content')` + `Y.Map('_review_status')`.
- Backend status sync keeps proposal rows current for `pending | accepted | rejected | stale | reverted`.

## Spec Documents

| Doc | Purpose |
|-----|---------|
| [Architecture](spec/architecture.md) | System design, boundaries, and locked decisions |
| [Append-Only Persistence](spec/append-only-persistence.md) | Update log, checkpoints/bookmarks, compaction model |
| [Dual-Version Yjs Model](spec/dual-version-yjs-model.md) | Canonical Y.Doc + ephemeral projection mental model |
| [Frontend Diff Model](spec/frontend-diff-model.md) | Projection/diff pipeline and grouped region hunks |
| [Local-First Authority](spec/local-first-authority.md) | Immediate local actions and backend status mirroring |
| [Review Undo Design](spec/review-undo-design.md) | Single UndoManager behavior across text + status map |
| [Schema Design](spec/schema-design.md) | Database schema, eliminated complexity, status sync |
| [Thread-Level Undo](spec/thread-level-undo.md) | Persistent undo/redo via stored before/after text |
| [Implementation Plan](spec/plan.md) | Phased execution plan and dependencies |

## Dependencies

- **Yjs collab foundation complete** -- canonical Y.Doc sync is the transport foundation.
- **Current proposal system stable** -- this redesign refines proposal resolution behavior.

## Relationship to Existing Plans

- **Supersedes** `collab-review-v2/spec/backend-hunk-authority.md` and `collab-review-v2/spec/proposal-undo.md` (v1 specs)
- **References** `_docs/technical/collab/` for implementation architecture docs
