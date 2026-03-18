---
detail: standard
audience: developer, architect
---
# Architecture: Collab Data Model Evolution

## Overview

This plan covers core data model changes to the collaboration system. The proposal model is participant-agnostic -- proposals can come from AI agents or human collaborators. The projection, diff, and undo primitives work the same regardless of who created the proposal.

### What's Changing

1. **Append-only persistence** -- replace `documents.yjs_state` overwrite with an update log, checkpoints, and bookmarks.
2. **Proposal payload model** -- proposals store `yjs_update` (binary Yjs operation) instead of derived text diffs.
3. **Decision state in Yjs** -- `Y.Map('_proposal_status')` on canonical Y.Doc tracks accept/reject/stale per proposal, enabling undo and sync.
4. **Ephemeral projection** -- no persistent projection document. Diff view is computed on demand from canonical + pending proposals, then discarded.
5. **Projection GC** -- auto-resolves proposals whose changes are already in canonical.

### Two Collaboration Modes

Collaborators (AI or human) write through the same pipeline regardless of mode. The mode is per-user and determines when incoming proposals land on canonical.

| Mode | When a proposal arrives... | User experience |
|------|---------------------------|-----------------|
| **Auto-apply** | yjs_update applied to canonical immediately, proposal marked `accepted` | Changes appear inline. User can revert via thread undo. |
| **Manual** | yjs_update stored as `pending` proposal | User sees diff hunks, accepts/rejects/edits when ready. No session -- changes accumulate continuously. |

Both modes are continuous. There is no "review session" with entry/exit. In manual mode, pending proposals are always visible as inline diffs whenever they exist.

When switching modes, pending proposals retain their pending status. New proposals follow the new mode's behavior. No proposals are auto-applied, discarded, or force-resolved on mode switch.

### Per-User Projection

Projection is per-user: only pending proposals where `created_by_user_id = current_user` are included. This means:

- Each user sees only their own pending proposals as diff hunks
- Other users' pending proposals are invisible until accepted into canonical
- The AI sees the same projected view as its thread owner (backend computes the same projection)
- Other users' AI activity can be shown as awareness indicators without revealing content

```mermaid
flowchart LR
    A["Collaborator proposes edit"] --> B["Backend creates proposal<br/>with yjs_update"]
    B --> C{"auto-apply?"}
    C -->|yes| D["Apply to canonical<br/>mark accepted<br/>broadcast"]
    C -->|no| E["Store as pending<br/>broadcast proposal:new"]
    E --> F["Owner's frontend derives diff<br/>shows inline hunks"]
    F --> G["Owner accepts/rejects<br/>whenever they want"]
```

### Backend Projection for AI Context

When an AI agent reads the document, the backend computes the same projection (clone canonical + apply the thread owner's pending proposals + extract text). The projection builder takes `(documentID, userID)` — it is user-scoped, not document-global. This ensures the AI works against the same view its owner sees. See [Frontend Diff Model](frontend-diff-model.md) for the projection computation algorithm.

### Proposal Independence

Proposals store `yjs_update` computed against canonical (not the projected view). The AI sees the projected view for writing context, but the `yjs_update` is diffed against canonical. Attribution cloning from canonical is intentional -- it ensures proposals are portable and apply cleanly regardless of projection state.

## Canonical + Projection Model

There is one materialized document authority: canonical `Y.Doc`. The projection is ephemeral and computed wherever needed -- frontend for diff UI, backend for AI document context.

```mermaid
flowchart LR
    subgraph doc ["Canonical Y.Doc (persistent, synced)"]
        T["Y.Text('content')"]
        M["Y.Map('_proposal_status')"]
        C["Y.Array('_comments')"]
    end
    doc -->|"clone + apply pending"| P["Projection clone"]
    P -->|"diff + group"| H["Grouped hunks"]
    H -->|"render, then destroy clone"| CM["CM6 inline diffs"]
```

- `Y.Text('content')` stores canonical text.
- `Y.Map('_proposal_status')` stores decision state by proposal.
- `Y.Array('_comments')` stores review comment annotations (see [Review Comments](../future/review-comments.md)).
- Projection is a throwaway clone. No projection state is stored in Postgres or Yjs.
- Frontend uses projection for diff UI (hunk rendering). Backend uses projection to give the AI the document view its owner sees.

### Example: What Lives Where

```
Canonical Y.Doc at some point in time:

  Y.Text('content'): "The cat sat on the mat."

  Y.Map('_proposal_status'):
    P1 -> 'accepted'     (writer accepted earlier)
    P3 -> 'rejected'     (writer rejected earlier)
    (P5 has no entry)   -> means pending

Pending proposals in DB (status = 'pending'):
  P5: yjs_update that inserts "fluffy " before "cat"

Projection (ephemeral):
  1. clone -> "The cat sat on the mat."
  2. apply P5 -> "The fluffy cat sat on the mat."
  3. diff -> one hunk: insert "fluffy " at pos 4, carries [P5]
  4. writer sees inline diff, acts when ready
  5. clone destroyed
```

P1 and P3 are skipped because they already have decisions. Only `pending` proposals feed the projection.

### Multi-User Hunk Visibility

One projection includes all pending proposals for the current user. In multi-user collaboration, other users' pending proposals are not in your projection. However, the frontend can query all pending proposals to render awareness indicators ("User B's AI edited near paragraph 3") without showing the actual content.

### Single Writer Per Proposal

Per-user projection ensures each proposal has exactly one writer who can accept/reject it: the user whose `created_by_user_id` matches. No two users can act on the same proposal concurrently. The only concurrent scenario is the same user on two tabs, where CRDT deterministic ordering resolves concurrent writes (Lamport clock, with clientID as tiebreaker — not wall-clock recency). This eliminates the need for a multi-user conflict policy on `_proposal_status`.

**Known edge case: same-user multi-tab concurrent actions.** If the same user accepts a proposal on tab A and rejects it on tab B within the Yjs sync window, Y.Map LWW resolves the status while the text mutation from accept merges independently. This can produce a transient inconsistent state (e.g., text applied but status = `rejected`). Full reconciliation on document load detects and repairs such inconsistencies. This is acceptable because the scenario requires the same user to act on the same proposal on two tabs within sub-second timing — rare enough that LWW resolution plus load-time repair is sufficient.

## Core Data Flow (Manual Path)

| Step | Operation | Persisted outcome |
|------|-----------|-------------------|
| Derive diff | Clone canonical, apply each `pending` proposal update, diff, group overlapping regions | None (ephemeral) |
| Projection GC | Text pre-check detects proposal is already in canonical -- mark `stale` | `_proposal_status` entry + proposal row |
| Accept hunk | Apply grouped hunk proposal updates to canonical + set `_proposal_status` to `accepted` in one transaction | Canonical text + status entries |
| Reject hunk | Set `_proposal_status` to `rejected` for each proposal in hunk | Status entries only |
| Edit | User types after reject, or modifies after accept (`ORIGIN_HUMAN`) | Canonical text mutation |
| Session undo | `undoManager.undo()` on unified stack | Reverts most recent tracked transaction |
| Thread undo | Offset-anchored find/replace (`region_text_after` -> `region_text_before`) + set `_proposal_status` to `reverted` | Canonical text + proposal row |
| Thread reapply | Offset-anchored find/replace (`region_text_before` -> `region_text_after`) + set `_proposal_status` to `accepted` | Canonical text + proposal row |
| Backend mirror | Observe `_proposal_status` deltas from Yjs sync | `proposals.status` mirrored |

### Example: Ephemeral Projection

Canonical document:

```
The cat sat on the mat.
```

Two pending proposals from different agents:

- **P1** (yjs_update): insert "black " before "cat" -> `The black cat sat on the mat.`
- **P2** (yjs_update): replace "mat" with "rug" -> `The cat sat on the rug.`

Projection pipeline:

1. Clone canonical -> `The cat sat on the mat.`
2. Apply P1 -> `The black cat sat on the mat.`
3. Apply P2 -> `The black cat sat on the rug.`
4. Diff vs canonical -> two raw hunks: insert "black " at pos 4, replace "mat" with "rug" at pos 24
5. These are far apart -> two separate hunk regions
6. Hunk A carries `[P1]`, Hunk B carries `[P2]`
7. Writer sees two inline diffs, acts on each independently

If P1 and P2 edited overlapping text (e.g., both touching "cat sat"), they'd merge into one grouped hunk carrying `[P1, P2]` -- accepting that hunk applies both.

### Example: Projection GC (Stale Proposal)

Canonical (writer already typed "black"):

```
The black cat sat on the mat.
```

Agent P3 proposes: insert "black " before "cat" -- but the canonical already has it.

Stale detection uses a **text pre-check**: if canonical already contains `region_text_after` at `proposed_at_offset`, the proposal is marked `stale` with `ORIGIN_GC` (not tracked by UndoManager) and skipped in projection. See [Frontend Diff Model](frontend-diff-model.md) — Projection GC for the full algorithm.

## State Model

| Layer | Authority | Shape |
|------|-----------|-------|
| Canonical document | Yjs | `Y.Text('content')` |
| Decision state | Yjs | `Y.Map('_proposal_status'): proposalId -> status` |
| Diff hunks | Frontend only | Ephemeral grouped regions from projection |
| Proposal row | Backend | `pending | accepted | rejected | stale | reverted` |

## Proposal Statuses

```mermaid
stateDiagram-v2
    [*] --> pending : collaborator proposes

    pending --> accepted : auto-apply / user accepts hunk
    pending --> rejected : user rejects hunk
    pending --> stale : projection GC
    stale --> pending : canonical rolls back (re-derive)

    accepted --> reverted : thread undo
    accepted --> pending : session Ctrl-Z (of accept)
    reverted --> accepted : thread reapply
    reverted --> accepted : session Ctrl-Z (of thread undo)
    rejected --> accepted : thread reapply

    rejected --> pending : session Ctrl-Z (of reject)
    accepted --> reverted : session Ctrl-Z (of thread reapply from reverted)
    accepted --> rejected : session Ctrl-Z (of thread reapply from rejected)

    [*] --> invalid : yjs_update validation fails

    note right of stale : Re-evaluated on every derive.<br/>Returns to pending if canonical<br/>no longer contains the change.
    note right of invalid : Terminal. Bad payload<br/>rejected at creation.
```

Note: Ctrl-Z transitions for thread ops are mechanical consequences of UndoManager restoring previous Y.Map values. No special handling needed — see [Undo Design](undo.md).

| Status | Meaning | Undo/Redo? |
|--------|---------|-----------|
| `pending` | Proposed, waiting for action | N/A |
| `accepted` | User accepted (or auto-applied) | Session Ctrl-Z or thread undo |
| `rejected` | User rejected | Session Ctrl-Z while in stack, or thread reapply |
| `stale` | Canonical already contains the change -- auto-resolved by projection GC. Non-terminal: re-evaluated on every derive, returns to `pending` if canonical rolls back (e.g., Ctrl-Z of the accept that caused staleness). | Re-derive |
| `reverted` | Was accepted, then thread-undone | Thread reapply |
| `invalid` | `yjs_update` failed validation at creation time (defense-in-depth). Backend-only — never enters `_proposal_status` Y.Map. | No |

## Proposal Creation

- Every proposal (from AI `edit_document` or human suggest-mode edit) creates one proposal row with `status = 'pending'` and its `yjs_update`. In auto-apply mode, the owner's frontend immediately accepts the proposal in the same tick (see [Local-First Authority](local-first-authority.md) — Auto-Apply Path).
- `proposal -> yjs_update -> status` chain stays current after every recompute and action.
- Projection GC marks no-diff pending proposals as `stale` on every derive.
- Thread UI reads proposal row status to show `accepted`, `rejected`, `stale`, `reverted`.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| No persistent projection document | Removes stale state and convergence machinery. Diff is computed on demand. |
| Proposals store `yjs_update` | Binary Yjs operations compose cleanly. No text-diff translation layer. |
| `_proposal_status` in Y.Doc | Enables Ctrl-Z for reject (Y.Map mutation is tracked by UndoManager) and delta-based backend sync. |
| Grouped region hunks | Users act on visible regions, not individual proposals. Multiple proposals can contribute to one hunk. |
| Immediate actions | No finalization step. Accept/reject are durable immediately. |
| Projection GC | Stale proposals are cleaned up automatically -- no manual resolution needed. |
| Edit is plain typing | No separate status. User types with `ORIGIN_HUMAN` after accept or reject. |
| Single UndoManager | One stack across `Y.Text` + `Y.Map`. `clear()` isolates undo history at mode transitions. |
| Append-only persistence | Update log with checkpoints and bookmarks. Foundation for timeline features. |

## Scope

**In scope:**
- Append-only persistence (update log, checkpoints, bookmarks)
- Ephemeral projection + diff pipeline for manual path
- Grouped hunk accept/reject as immediate Yjs transactions
- Projection GC for stale proposal auto-resolution
- `_proposal_status` Y.Map semantics, undo, and backend sync
- Thread-level undo/reapply via offset-anchored text search

**Out of scope:**
- Multi-user concurrent conflict policy (beyond single-writer-per-proposal — see below)
- Backend hunk derivation or persistence
- Persistent projection Y.Doc
- Proposal discovery/notification UX (badge counts, jump-to-next)
- Collaborative awareness indicator design
- Accept All / Reject All bulk operations (data model supports them; UX is deferred)

## Cross-References

- [Append-Only Persistence](append-only-persistence.md)
- [Frontend Diff Model](frontend-diff-model.md)
- [Local-First Authority](local-first-authority.md)
- [Undo Design](undo.md)
- [Schema Design](schema-design.md)
- [Implementation Plan](plan.md)
