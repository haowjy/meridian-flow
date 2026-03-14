---
detail: standard
audience: developer, architect
---
# Local-First Review Authority

## Overview

Review behavior is local-first on canonical Yjs data structures. The frontend applies actions immediately; the backend mirrors status from synced Yjs state.

Every AI `edit_tool` call creates a proposal row with `status = 'pending'` and a `yjs_update` payload. The frontend and backend keep that proposal status current through accept/reject, projection GC (`stale`), and thread undo/redo (`reverted`).

## Authority Boundary

| Concern | Authority | Storage | Notes |
|---|---|---|---|
| Canonical document text | Yjs | `Y.Text('content')` | Synced via existing collab transport |
| Review status map | Yjs | `Y.Map('_review_status')` | Decision ledger for `accepted`, `rejected`, `stale` |
| Diff derivation | Frontend | Ephemeral | Projection + diff only |
| Accept/reject hunk actions | Frontend | Yjs transactions | Immediate, undoable |
| Projection GC | Frontend | Yjs transaction | Auto-marks stale proposals during recompute |
| Session undo/redo | Frontend | UndoManager in memory | Session-scoped |
| Proposal status row | Backend + mirror | `proposals.status` | Always current: `pending`, `accepted`, `rejected`, `stale`, `reverted` |
| Thread undo/redo | Backend | `region_text_before/after` | Persistent, status-gated |

## Immediate Operations

### Accept Hunk

```typescript
canonicalDoc.transact(() => {
  for (const proposal of hunk.proposals) {
    Y.applyUpdate(canonicalDoc, proposal.yjs_update);
    canonicalDoc.getMap('_review_status').set(proposal.id, 'accepted');
  }
}, ORIGIN_REVIEW_ACCEPT);
```

- Applies all grouped hunk proposal updates to canonical text.
- Writes all proposal statuses in the same transaction.
- Syncs to backend through normal Yjs update flow.

### Reject Hunk

```typescript
canonicalDoc.transact(() => {
  for (const proposal of hunk.proposals) {
    canonicalDoc.getMap('_review_status').set(proposal.id, 'rejected');
  }
}, ORIGIN_REVIEW_REJECT);
```

- No canonical text mutation.
- Projection excludes this hunk's proposals on the next derive.

### Edit

```typescript
canonicalDoc.transact(() => {
  applyUserEditToCanonical(canonicalDoc.getText('content'), editPatch);
}, ORIGIN_HUMAN);
```

- User edit lands directly in canonical text.
- No separate review-edit status value exists.
- Edit flow is reject + type, or accept + modify.

### Projection GC

```typescript
canonicalDoc.transact(() => {
  for (const proposal of pendingProposalsWithoutDiff) {
    canonicalDoc.getMap('_review_status').set(proposal.id, 'stale');
  }
}, ORIGIN_GC);
```

- Runs on every projection recompute.
- Keeps the `edit_tool -> proposal -> yjs_update -> status` chain current.
- Stale proposals are removed from hunk UI and shown as "No longer relevant" in thread UI.

### Undo

```typescript
undoManager.undo();
```

- Reverts the last tracked mutation from text or status map.
- No backend command path is required for undo semantics.

## Backend Status Mirroring

Backend logic on Yjs sync:

1. Detect `_review_status` key changes by `proposalId`.
2. Upsert proposal-row status to match map value (`accepted`, `rejected`, `stale`).
3. Thread undo updates proposal row status to `reverted` directly.
4. Keep row status current for UI (`pending`, `accepted`, `rejected`, `stale`, `reverted`).

## Reconnect / Reload

| State | Reconnect (same tab) | Reload (new tab) |
|-------|-----------------------|------------------|
| Canonical text | Synced | Rehydrated from backend |
| `_review_status` | Synced via Yjs deltas | Rehydrated from canonical Yjs state |
| Undo stack | Preserved | Lost |
| Display hunks | Re-derived | Re-derived |

## Implementation Notes

Backend status mirroring is event-driven from `_review_status` Y.Map deltas only; no full-state reconciliation step is needed on reconnect because Yjs sync already guarantees convergence.

## Cross-References

- [Architecture](architecture.md)
- [Dual-Version Yjs Model](dual-version-yjs-model.md)
- [Frontend Diff Model](frontend-diff-model.md)
- [Review Undo Design](review-undo-design.md)
- [Implementation Plan](plan.md)
