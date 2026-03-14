---
detail: standard
audience: developer, architect
---
# Review Undo Design

## Overview

Session undo uses one `Y.UndoManager` across:

- `Y.Text('content')`
- `Y.Map('_review_status')`

All tracked actions interleave in a single stack: typing, grouped-hunk accept/reject, and projection GC status writes.

## UndoManager Setup

```typescript
const ORIGIN_HUMAN = 'human';
const ORIGIN_REVIEW_ACCEPT = 'review:accept';
const ORIGIN_REVIEW_REJECT = 'review:reject';
const ORIGIN_REVIEW_GC = 'review:gc';

const undoManager = new Y.UndoManager(
  [doc.getText('content'), doc.getMap('_review_status')],
  {
    trackedOrigins: new Set([
      ORIGIN_HUMAN,
      ORIGIN_REVIEW_ACCEPT,
      ORIGIN_REVIEW_REJECT,
      ORIGIN_REVIEW_GC,
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
}, ORIGIN_REVIEW_GC);
```

## Ctrl-Z Behavior

`undoManager.undo()` reverts the most recent tracked transaction.

| Last action | Undo effect |
|-------------|-------------|
| Accept hunk | Reverts all grouped proposal updates and status writes as one step |
| Reject hunk | Reverts all grouped status writes as one step |
| Typing | Reverts recent text change |
| Projection GC | Reverts stale status writes |

## Persistence Model

| State | Persistent? | Notes |
|-------|-------------|-------|
| Canonical text | Yes | Yjs synced |
| `_review_status` entries | Yes (time-bounded) | Yjs synced, cleaned by 7-day retention job |
| Undo stack | No | In-memory session state |

## Proposal Status Matrix

| Status | Meaning | Undo/Redo? |
|--------|---------|-----------|
| `pending` | Waiting for review | N/A |
| `accepted` | User explicitly accepted | Yes (thread undo) |
| `rejected` | User explicitly rejected | Yes (Ctrl+Z within 7 days) |
| `stale` | Auto-resolved, canonical diverged and no diff remains | No |
| `reverted` | Accepted then thread-undone | Yes (thread redo) |

## 7-Day Retention Job

Server job behavior:

1. Find proposal decisions older than 7 days.
2. Remove corresponding `_review_status[proposalId]` entries from canonical docs.
3. Leave canonical text unchanged.

Result:
- Old decision-map entries are trimmed.
- If a user attempts Ctrl-Z against aged-out reject state, the operation no-ops safely.
- Thread-level undo/redo is unaffected because it uses persisted proposal text regions and row status.

## Backend Status Mirror

Backend updates proposal rows from `_review_status` changes:

- `accepted` -> proposal row `accepted`
- `rejected` -> proposal row `rejected`
- `stale` -> proposal row `stale`
- key removed -> no decision entry remains in map

Thread-level undo/redo updates proposal rows to `reverted`/`accepted` directly and does not mutate `_review_status`.

## Cross-References

- [Architecture](architecture.md)
- [Local-First Authority](local-first-authority.md)
- [Frontend Diff Model](frontend-diff-model.md)
- [Thread-Level Undo](thread-level-undo.md)
- [Implementation Plan](plan.md)
