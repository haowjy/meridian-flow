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
| Safety-notice production + writer delivery | `composition.ts`, `routes/ws/yjs.ts`, `domains/notices/` |

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
  Reversal rows keep `origin_type = system` for redo classification and store the
  independent `reversal_actor_type` attribution used by other sessions.
- `document_branches` stores branch snapshots/state vectors/generation.
- `branch_write_journal` stores branch write rows and review status.
- `push_lineage` records pushes to live and receipts.

The deleted legacy draft tables (`document_yjs_drafts`,
`document_yjs_draft_updates`) are not part of the model.

## Undo guard and push safety

- **Canonical reversal is live-scoped**: hosted `reverse()` uses the live utility
  core, never the thread-peer branch committer. The host captures a live Yjs
  snapshot and live-journal sequence together before entering agent-edit.
- **Intrinsic undo guard**: `persistUndo` in `adapters/drizzle-journal.ts` runs
the dependency check (`hasDependentLaterRows` in `domain/journal-dependencies.ts`)
inside the same transaction, under `lockDocumentMutation` advisory lock. There is
no separate `ReversalCommitGuard` — the guard is intrinsic, never optional.
- **Tombstone cap**: `gc: false` on all branch `Y.Doc` instances — full struct
history is preserved for attribution, echo, and undo dependency checking.
- **Sorted push locks**: branch-level locks (generation CAS) and document-level
locks (push mutex keyed by `documentId`) are ordered one-way (push mutex →
branch lock); no lock inversion deadlock possible.
- **Late-sweep receipts**: response finalization records a thread-scoped,
  writer-visible `late_sweep` notice with the before-state journal reference and
  a captured body for every swept hash. Hocuspocus forwards writer-visible
  notices as stateless `safety_notice` messages; model delivery drains the same
  notice port rather than a parallel result channel.
- **Response-scoped thread-peer durability**: multi-document response flushes run
  inside one ambient Drizzle transaction. Branch snapshot caches and broadcasts
  publish only after that outer transaction commits, so a later document failure
  leaves no earlier work-draft journal row or cache-visible durable state.
