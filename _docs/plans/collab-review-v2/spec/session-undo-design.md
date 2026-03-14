---
detail: standard
audience: developer, architect
---
# Session Undo Design

## Overview

Session undo uses one `Y.UndoManager` across:

- `Y.Text('content')`
- `Y.Map('_proposal_status')`

All tracked actions interleave in a single stack: typing and grouped-hunk accept/reject.

## UndoManager Setup

```typescript
const ORIGIN_HUMAN = 'human';
const ORIGIN_ACCEPT = 'accept';
const ORIGIN_REJECT = 'reject';
const ORIGIN_GC = 'gc';
const ORIGIN_THREAD = 'thread';

const undoManager = new Y.UndoManager(
  [doc.getText('content'), doc.getMap('_proposal_status')],
  {
    trackedOrigins: new Set([
      ORIGIN_HUMAN,
      ORIGIN_ACCEPT,
      ORIGIN_REJECT,
      ORIGIN_THREAD,
    ]),
  }
);

// On mode transition (e.g., toggling manual diff view)
undoManager.clear();
```

## Action Transactions

### Accept Hunk

```typescript
doc.transact(() => {
  for (const proposal of hunk.proposals) {
    Y.applyUpdate(doc, proposal.yjs_update);
    doc.getMap('_proposal_status').set(proposal.id, 'accepted');
  }
}, ORIGIN_ACCEPT);
```

### Reject Hunk

```typescript
doc.transact(() => {
  for (const proposal of hunk.proposals) {
    doc.getMap('_proposal_status').set(proposal.id, 'rejected');
  }
}, ORIGIN_REJECT);
```

### Edit

```typescript
doc.transact(() => {
  applyUserEditToCanonical(doc.getText('content'), editPatch);
}, ORIGIN_HUMAN);
```

### Projection GC

```typescript
doc.transact(() => {
  for (const proposal of pendingProposalsWithoutDiff) {
    doc.getMap('_proposal_status').set(proposal.id, 'stale');
  }
}, ORIGIN_GC);
```

## Ctrl-Z Behavior

`undoManager.undo()` reverts the most recent tracked transaction.

| Last action | Undo effect |
|-------------|-------------|
| Accept hunk | Reverts all grouped proposal updates and status writes as one step |
| Reject hunk | Reverts all grouped status writes as one step |
| Typing | Reverts recent text change |

### Example: Interleaved Undo Stack

Writer performs these actions in order:

```
1. Type "Hello "                          (ORIGIN_HUMAN)
2. Accept hunk [P1]                       (ORIGIN_ACCEPT)
3. Type "world"                           (ORIGIN_HUMAN)
4. Reject hunk [P2, P3]                   (ORIGIN_REJECT)
```

Undo stack (top = most recent):

```
[4] Reject [P2,P3]:  Y.Map set(P2,'rejected') + set(P3,'rejected')
[3] Type:            Y.Text insert "world"
[2] Accept [P1]:     Y.Text apply P1 update + Y.Map set(P1,'accepted')
[1] Type:            Y.Text insert "Hello "
```

Ctrl-Z sequence:

```
1st Ctrl-Z → undo [4]: P2 and P3 rejections reverted, both hunks reappear
2nd Ctrl-Z → undo [3]: "world" removed from text
3rd Ctrl-Z → undo [2]: P1 text reverted + P1 back to pending, hunk reappears
4th Ctrl-Z → undo [1]: "Hello " removed
```

All operations interleave in one chronological stack. No separate stacks for typing vs actions.

### Why ORIGIN_GC Is Not Tracked

Projection GC uses `ORIGIN_GC` which is NOT in `trackedOrigins`. If GC marks P4 as `stale`, that write is invisible to UndoManager. Ctrl-Z will never "un-stale" a proposal — stale is terminal and automatic.

## Persistence Model

| State | Persistent? | Notes |
|-------|-------------|-------|
| Canonical text | Yes | Yjs synced |
| `_proposal_status` entries | Yes | Yjs synced |
| Undo stack | No | In-memory session state |

## Proposal Status Matrix

| Status | Meaning | Undo/Redo? |
|--------|---------|-----------|
| `pending` | Waiting for action | N/A |
| `accepted` | User explicitly accepted or auto-applied | Yes (thread undo) |
| `rejected` | User explicitly rejected | Session Ctrl-Z while in stack, or thread reapply |
| `stale` | Auto-resolved, canonical diverged and no diff remains | No |
| `reverted` | Accepted then thread-undone | Yes (thread reapply) |

## Backend Status Mirror

Backend updates proposal rows from `_proposal_status` changes:

- `accepted` -> proposal row `accepted`
- `rejected` -> proposal row `rejected`
- `stale` -> proposal row `stale`
- key removed -> no decision entry remains in map

Thread-level undo/reapply writes to `_proposal_status` Y.Map using `ORIGIN_THREAD` (non-tracked). The backend mirrors the map change to the proposal row through the standard sync path.

## Implementation Notes

Projection GC stale writes must use a non-tracked origin (for example, `ORIGIN_GC`) so they never pollute the undo stack.

## Cross-References

- [Architecture](architecture.md)
- [Local-First Authority](local-first-authority.md)
- [Frontend Diff Model](frontend-diff-model.md)
- [Thread-Level Undo](thread-level-undo.md)
- [Implementation Plan](plan.md)
