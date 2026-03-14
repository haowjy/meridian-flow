---
detail: standard
audience: developer, architect
---
# Architecture: Projection + `_review_status`

## Overview

The review system is built on five decisions:

1. One canonical Y.Doc is the only materialized document authority.
2. Review diffs are ephemeral projections, not stored artifacts.
3. User-facing hunks are grouped text regions, not one-proposal records.
4. Accept/reject are immediate local transactions over grouped hunks.
5. `_review_status` (Y.Map keyed by `proposalId`) is decision state used for sync and undo windows.

## Core Data Flow

| Step | Operation | Persisted outcome |
|------|-----------|-------------------|
| Load review | Clone canonical, apply each `pending` proposal update, diff to raw hunks, group nearby/overlapping hunks, discard projection | No projection storage |
| Projection GC | If a pending proposal yields no remaining diff, mark it `stale` | Proposal row status + `_review_status` entry become `stale` |
| Accept hunk | Apply all proposal updates in the grouped hunk + set `_review_status[proposalId]='accepted'` for each proposal in one transaction | Canonical text + status entries |
| Reject hunk | Set `_review_status[proposalId]='rejected'` for each proposal in the grouped hunk in one transaction | Status entries |
| Edit hunk | User types directly (`ORIGIN_HUMAN`) after reject, or modifies after accept | Canonical text mutation only |
| Session undo | `undoManager.undo()` on unified stack | Reverts most recent tracked hunk/status transaction |
| Thread undo | Backend find/replace (`region_text_after -> region_text_before`) and row status update | Canonical text mutation + proposal row `reverted` |
| Backend mirror | Observe `_review_status` changes from Yjs sync | `proposals.status` mirrored for `accepted`, `rejected`, `stale` |

## State Model

| Layer | Authority | Shape |
|------|-----------|-------|
| Canonical document | Yjs | `Y.Text('content')` |
| Review status | Yjs | `Y.Map('_review_status'): proposalId -> status` |
| Diff hunks | Frontend only | Ephemeral grouped regions derived from projection vs canonical |
| Proposal lifecycle row | Backend | `pending | accepted | rejected | stale | reverted` |

## Proposal Statuses

| Status | Meaning | Undo/Redo? |
|--------|---------|-----------|
| `pending` | Waiting for review | N/A |
| `accepted` | User explicitly accepted | Yes (thread undo) |
| `rejected` | User explicitly rejected | Yes (session Ctrl-Z while still in stack) |
| `stale` | Auto-resolved, canonical diverged and no diff remains | No |
| `reverted` | Accepted then thread-undone | Yes (thread redo) |

## Edit Tool Linkage

- Every AI `edit_tool` call creates one proposal row with `status = 'pending'` and its `yjs_update`.
- The `edit_tool -> proposal -> yjs_update -> status` chain must stay current after every recompute and action.
- Projection GC runs on every derive to mark no-diff pending proposals as `stale`.
- Thread UI reads proposal row status and reflects `accepted`, `rejected`, `stale`, and `reverted`.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| No persistent AI document | Removes stale state and convergence machinery. |
| No backend hunk table | Hunks are view artifacts, not backend entities. |
| Hunk identity is region-based | Users act on grouped regions that can include multiple proposals. |
| Immediate hunk actions | No delayed resolution step; each user action is durable immediately. |
| Accept/reject are atomic per hunk | All grouped proposal updates/status writes happen in one transaction. |
| Projection GC runs every re-derive | Stale proposals are auto-resolved and removed from review surface. |
| Edit is plain typing | No separate review-edit status value or origin; user edits are normal human text operations. |
| Status chain is always current | `edit_tool -> proposal -> yjs_update -> status` stays synchronized in UI and backend row. |
| Single UndoManager | One stack across `Y.Text('content')` and `Y.Map('_review_status')`. |
| Undo boundaries use `clear()` | Entering/leaving review mode isolates review undo history. |

## In Scope

- Ephemeral projection + diff pipeline
- Grouped hunk accept/reject transactions
- Projection GC to auto-resolve stale proposals
- `_review_status` map semantics and undo behavior
- Backend mirror of proposal status from `_review_status` plus thread undo row updates
- Thread-level undo/redo via stored before/after text

## Out of Scope

- Multi-user concurrent review conflict policy
- Backend hunk derivation or hunk persistence
- Persistent AI-version Y.Text/Y.Doc
- Alternate review persistence stores outside canonical Y.Doc

## Cross-References

- [Dual-Version Yjs Model](dual-version-yjs-model.md)
- [Frontend Diff Model](frontend-diff-model.md)
- [Local-First Authority](local-first-authority.md)
- [Review Undo Design](review-undo-design.md)
- [Schema Design](schema-design.md)
- [Thread-Level Undo](thread-level-undo.md)
- [Implementation Plan](plan.md)
