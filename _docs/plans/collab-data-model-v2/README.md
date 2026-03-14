---
detail: standard
audience: developer, architect
---
# Collab Data Model v2

**Status:** draft

## Why

The v1 collab design accumulated unnecessary complexity: legacy text-derived hunk identity, extra review-state indirection, delayed resolution semantics, and a persistent AI document. v2 simplifies to one canonical Y.Doc, ephemeral projection, and immediate undoable actions.

This plan covers core data model changes (append-only persistence, yjs_update proposals, decision state in Yjs) and the manual-path experience for reviewing proposed changes. The proposal model is participant-agnostic — proposals can come from AI agents or human collaborators. Both auto-apply and manual modes are continuous.

## Core Model

```mermaid
flowchart LR
    A["Collaborator proposes edit"] --> B["Proposal with yjs_update"]
    B --> C{"auto-apply?"}
    C -->|yes| D["Apply to canonical<br/>mark accepted"]
    C -->|no| E["Store as pending"]
    E --> F["Per-user projection:<br/>clone + apply + diff"]
    F --> G["Owner sees inline hunks<br/>accepts/rejects when ready"]
```

- One canonical Y.Doc: `Y.Text('content')` + `Y.Map('_proposal_status')`
- Proposals store `yjs_update` (binary Yjs operations)
- Diff is ephemeral: clone canonical, apply pending proposals, diff, group into hunks, discard
- Actions are immediate: accept/reject are Yjs transactions, undoable via Ctrl-Z
- Projection GC auto-marks stale proposals (no remaining diff)
- Thread-level undo/reapply: revert or reapply any individual proposal through the UI, in either mode
- Per-user projection: each user sees only their own pending proposals; other users' activity shown as awareness indicators

## Spec Documents

| Doc | Purpose |
|-----|---------|
| [Architecture](spec/architecture.md) | Data model evolution, two modes, key decisions |
| [Append-Only Persistence](spec/append-only-persistence.md) | Update log, checkpoints, bookmarks, compaction |
| [Dual-Version Yjs Model](spec/dual-version-yjs-model.md) | Canonical Y.Doc + ephemeral projection mental model |
| [Frontend Diff Model](spec/frontend-diff-model.md) | Projection/diff pipeline and grouped region hunks |
| [Local-First Authority](spec/local-first-authority.md) | Immediate local actions and backend status mirroring |
| [Session Undo Design](spec/session-undo-design.md) | Single UndoManager across text + status map |
| [Schema Design](spec/schema-design.md) | Database schema, dual authority, eliminated complexity |
| [Thread-Level Undo](spec/thread-level-undo.md) | Per-proposal undo/reapply via stored before/after text |
| [Implementation Plan](spec/plan.md) | Phased execution plan and dependencies |

## Dependencies

- **Yjs collab foundation complete** -- canonical Y.Doc sync is the transport foundation.
- **Current proposal system stable** -- this redesign refines proposal resolution behavior.

## Relationship to Existing Plans

- **Supersedes** v1 specs (`backend-hunk-authority.md`, `proposal-undo.md`)
- **References** `_docs/technical/collab/` for current implementation docs
