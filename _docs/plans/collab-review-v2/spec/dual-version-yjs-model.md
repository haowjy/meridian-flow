---
detail: standard
audience: developer, architect
---
# Dual-Version Yjs Model: Canonical + Ephemeral Projection

## Mental Model

There is one materialized document authority: canonical `Y.Doc`.

- `Y.Text('content')` stores canonical text.
- `Y.Map('_review_status')` stores review decision state by proposal.

The projection is temporary and local:

1. clone canonical
2. apply each `pending` proposal update while tracking touched regions
3. diff against canonical to produce raw hunks
4. group nearby or overlapping raw hunks into user-facing regions
5. discard projection

No projection state is stored in Postgres or Yjs.

## Data Structures

| Structure | Lifetime | Purpose |
|-----------|----------|---------|
| Canonical Y.Doc | Persistent | Shared document state |
| `_review_status` Y.Map | Persistent (7-day status retention) | Proposal decision state |
| Projection Y.Doc clone | Ephemeral | Diff derivation input |
| Raw hunks | Ephemeral | Direct diff output before grouping |
| Grouped hunks | Ephemeral | UI rendering regions mapped to proposal sets |

## Projection Computation

```typescript
const projection = cloneDoc(canonicalDoc);
const proposalTouches = new Map<ProposalId, TextRegionSet>();

for (const proposal of proposals) {
  if (proposal.status === 'pending') {
    const touched = applyUpdateAndTrackRegions(projection, proposal.yjs_update);
    proposalTouches.set(proposal.id, touched);
  }
}

const rawHunks = deriveRawHunks(
  toPlainText(canonicalDoc.getText('content')),
  toPlainText(projection.getText('content'))
);

const groupedHunks = groupNearbyOrOverlapping(rawHunks);
attachContributingProposals(groupedHunks, proposalTouches);
autoResolveStaleProposals(groupedHunks, proposals);

projection.destroy();
```

## Immediate Resolution Effects

- Accept hunk applies all contributing proposal updates to canonical and sets `_review_status[proposalId]='accepted'` for each proposal atomically.
- Reject hunk sets `_review_status[proposalId]='rejected'` for each contributing proposal atomically.
- Edit is plain `ORIGIN_HUMAN` typing after reject, or modification after accept.
- Projection GC marks pending proposals as `stale` when their update yields no remaining diff.

Accept/reject and stale-GC writes are normal Yjs transactions and therefore sync through existing collab transport.

## Undo Integration

The same UndoManager tracks:

- canonical text mutations
- `_review_status` mutations

This gives one chronological undo stack for typing + review actions.

## Backend Mirror

Backend listens to synced canonical state changes and mirrors `_review_status` values into proposal-row status for querying/reporting. Thread undo writes `reverted` directly on proposal rows and does not mutate `_review_status`.

## What Does Not Exist

- No persistent AI-version Y.Doc or Y.Text
- No `ai_content` column
- No backend hunk table
- No one-proposal-to-one-hunk identity
- No separate review-edit proposal status value
- No extra review command protocol

## Cross-References

- [Architecture](architecture.md)
- [Frontend Diff Model](frontend-diff-model.md)
- [Local-First Authority](local-first-authority.md)
- [Review Undo Design](review-undo-design.md)
- [Schema Design](schema-design.md)
