---
detail: standard
audience: developer, architect
---
# Review Undo Design

## Overview

Session undo uses one `Y.UndoManager` across:

- `Y.Text('content')`
- `Y.Map('_review_status')`

All tracked actions interleave in a single stack: typing and grouped-hunk accept/reject.

## UndoManager Setup

```typescript
const ORIGIN_HUMAN = 'human';
const ORIGIN_REVIEW_ACCEPT = 'review:accept';
const ORIGIN_REVIEW_REJECT = 'review:reject';
const ORIGIN_GC = 'review:gc';

const undoManager = new Y.UndoManager(
  [doc.getText('content'), doc.getMap('_review_status')],
  {
    trackedOrigins: new Set([
      ORIGIN_HUMAN,
      ORIGIN_REVIEW_ACCEPT,
      ORIGIN_REVIEW_REJECT,
    ]),
  }
);

// Enter review mode
undoManager.clear();

// Exit review mode
undoManager.clear();
```

## Action Transactions

### Accept Hunk

```typescript
doc.transact(() => {
  for (const proposal of hunk.proposals) {
    Y.applyUpdate(doc, proposal.yjs_update);
    doc.getMap('_review_status').set(proposal.id, 'accepted');
  }
}, ORIGIN_REVIEW_ACCEPT);
```

### Reject Hunk

```typescript
doc.transact(() => {
  for (const proposal of hunk.proposals) {
    doc.getMap('_review_status').set(proposal.id, 'rejected');
  }
}, ORIGIN_REVIEW_REJECT);
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
    doc.getMap('_review_status').set(proposal.id, 'stale');
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

## Persistence Model

| State | Persistent? | Notes |
|-------|-------------|-------|
| Canonical text | Yes | Yjs synced |
| `_review_status` entries | Yes | Yjs synced |
| Undo stack | No | In-memory session state |

## Proposal Status Matrix

| Status | Meaning | Undo/Redo? |
|--------|---------|-----------|
| `pending` | Waiting for review | N/A |
| `accepted` | User explicitly accepted | Yes (thread undo) |
| `rejected` | User explicitly rejected | Yes (session Ctrl-Z while still in stack) |
| `stale` | Auto-resolved, canonical diverged and no diff remains | No |
| `reverted` | Accepted then thread-undone | Yes (thread redo) |

## Backend Status Mirror

Backend updates proposal rows from `_review_status` changes:

- `accepted` -> proposal row `accepted`
- `rejected` -> proposal row `rejected`
- `stale` -> proposal row `stale`
- key removed -> no decision entry remains in map

Thread-level undo/redo updates proposal rows to `reverted`/`accepted` directly and does not mutate `_review_status`.

## Implementation Notes

Projection GC stale writes must use a non-tracked origin (for example, `ORIGIN_GC`) so they never pollute the undo stack.

## Cross-References

- [Architecture](architecture.md)
- [Local-First Authority](local-first-authority.md)
- [Frontend Diff Model](frontend-diff-model.md)
- [Thread-Level Undo](thread-level-undo.md)
- [Implementation Plan](plan.md)
