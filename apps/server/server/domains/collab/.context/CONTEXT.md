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
- **Sorted push locks**: pushes acquire the store's real branch mutexes in
branch-id order, then live coordinator document locks in document-id order.
- **Destructive push baseline**: human attribution starts at the live update
sequence of the branch fork, or the last durable push preceding the earliest
pending row. It never starts from push-time live state.
- **Late-sweep receipts**: response finalization records a thread-scoped,
  writer-visible `late_sweep` notice with the before-state journal reference and
  a captured body for every swept hash. Hocuspocus forwards writer-visible
  notices as stateless `safety_notice` messages; model delivery drains the same
  notice port rather than a parallel result channel.
- **Response-scoped thread-peer atomicity**: `domain/response-transaction.ts`
  settles cache publication, watermarks, facade ownership, and response lifecycle
  against the actual ambient Drizzle commit or rollback. The real-Postgres
  `composition.response-atomicity.integration.test.ts` proves a failed
  multi-document flush leaves no durable or process-local residue and is retryable.
- **Transaction-context transport**: `response-transaction.ts` uses
  `AsyncLocalStorage` (parallel to the existing Drizzle ambient-transaction
  context) to carry response-transaction enrollment through arbitrary call depth.
  Deep code calls `enlistResponseParticipant()` without explicit parameters;
  settlement is bound to the real DB outcome via `deferUntilDrizzleCommit` /
  `deferUntilDrizzleRollback`.
- **Participant settlement contract**: enrolled `ResponseCommitParticipant`s
  expose `commit()`, `abort()`, and optional best-effort
  `onCommitFailure(cause)`. Commit runs in enrollment order after DB commit;
  abort runs in reverse enrollment order on rollback. An abort failure is
  aggregated with the transaction failure. A participant commit failure after
  durability is logged, offered to `onCommitFailure`, and never rethrown as a
  rollback-shaped response error; later participants still settle.
- **Post-durability notice-failure honesty contract**: when a safety/awareness
  notice fails after the underlying write is durable, the system catches and
  structured-logs the failure, sets the READ-REQUIRED fence on affected
  documents, and attempts an `awareness_degraded` notice (no body requirement).
  If the fallback record also fails, that failure is logged and the fence
  remains. Durability cannot be rolled back or reported as a retryable failure.
- **Human-only gate classification**: the destructive-write safety gate
  intersects the candidate's `deletedHashes` against concurrent
  HUMAN-origin touched hashes only (`humanTouchedHashes`). Other-agent
  edits do not trigger rejection — the safety promise is to prevent an agent
  from silently deleting a writer's work.
- **Actor-scoped reversal fence**: agent-actor (model-facing) reversals
  consult the READ-REQUIRED fence before execution; user-actor reversals
  are exempt (explicit user intent). Fence consultation occurs in the
  agent-edit reversal endpoint (`write-reversal-endpoints.ts`).

## LOCK-WS boundary

`withDocument()` serializes coordinator callers, not writer WebSocket updates:
Hocuspocus can mutate the same in-memory Y.Doc while a coordinator callback is
awaiting journal or detection work. For any safety-relevant apply after an
`await`, the last live snapshot diff and `Y.applyUpdate` must therefore be one
synchronous block. The diff catches unpersisted WS changes that journal-based
detection cannot see; an overlap becomes a `late_sweep` report rather than a
claim that the apply was clean.

The response phase-C path enforces this in
`@meridian/agent-edit`'s `applyCommittedUpdateWithRecheck`. Branch push also
enforces the invariant while holding sorted branch locks followed by sorted live
document locks. Reversal `executePrepared` snapshots around the durable write,
then delegates its final recheck and apply to `applyCommittedUpdateWithRecheck`.
Do not treat the coordinator mutex as coverage for WebSocket mutations.

- **Push LOCK-WS recheck**: every live document is snapshotted synchronously at
  lock acquisition. After durable push commit, the final snapshot diff and live
  apply share one synchronous block; swept WS edits produce document-scoped,
  writer-visible `late_sweep` notices because pushes do not reliably own a thread.
