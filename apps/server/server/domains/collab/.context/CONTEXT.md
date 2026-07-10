# collab — branch-backed document infrastructure

The server collab domain supplies concrete Postgres/Hocuspocus adapters around
`@meridian/agent-edit` and exposes `CollabDomain` to routes, runtime, context,
and WebSocket callers.

## Current shape

| Concern | Location |
|---|---|
| Live Yjs journal/checkpoints/reversal metadata | `adapters/drizzle-journal.ts` |
| Live Y.Doc coordination | `adapters/hocuspocus-coordinator.ts` |
| Branch rows and branch state | `adapters/drizzle-branches.ts`, `domain/branch-coordinator.ts` |
| Thread-peer agent-edit binding | `domain/branch-agent-edit.ts` |
| Live→branch pull propagation | `domain/branch-pulls.ts` |
| Work-draft push/discard/reverse | `domain/branch-push.ts`, `adapters/drizzle-branch-push.ts` |
| Review diff/cards | `domain/draft-review-hunks.ts`, `domain/branch-review-closure.ts` |
| Hocuspocus persistence | `hocuspocus-persistence.ts` |

## Branch model

Branches are real Y.Docs. A thread peer starts from the Work draft, receives live
pulls by CRDT sync, and stages agent writes. The Work draft is the writer review
branch. Pushing computes a Yjs update from branch to live, records push lineage,
marks source journal rows reviewed, and resets/advances branch generation where
needed.

Propagation is sync-only: no basis reconstruction, draft projection, accept token,
reactivation fence, or scope routing. Cold attribution uses persisted branch
journal rows and live journal metadata; memory-only runtime maps are never an
attribution authority.

## Durable records

- `document_yjs_updates` is the live update journal.
- `document_branches` stores branch snapshots/state vectors/generation.
- `branch_write_journal` stores branch write rows and review status.
- `push_lineage` records pushes to live and receipts.

The deleted legacy draft tables (`document_yjs_drafts`,
`document_yjs_draft_updates`) are not part of the model.

## Undo guard and push safety

- **Intrinsic undo guard**: `persistUndo` in `adapters/drizzle-journal.ts` runs
the dependency check (`hasDependentLaterRows` in `domain/journal-dependencies.ts`)
inside the same transaction, under `lockDocumentMutation` advisory lock. There is
no separate `ReversalCommitGuard` — the guard is intrinsic, never optional.
- **Tombstone cap**: `gc: false` on all branch `Y.Doc` instances — full struct
history is preserved for attribution, echo, and undo dependency checking.
- **Sorted push locks**: pushes acquire the store's real branch mutexes in
branch-id order, then live coordinator document locks in document-id order.
- **Destructive push baseline**: human attribution starts at the live update
sequence of the branch fork, or the last durable push preceding the earliest
pending row. It never starts from push-time live state.
