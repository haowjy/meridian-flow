# collab — branch-backed document infrastructure

The server collab domain supplies concrete Postgres/Hocuspocus adapters around
`@meridian/agent-edit` and exposes `CollabDomain` to routes, runtime, context,
and WebSocket callers.

## Current shape

| Concern | Location |
|---|---|
| Live Yjs journal/checkpoints/reversal metadata | `adapters/drizzle-journal.ts` |
| Response observation snapshots | `adapters/drizzle-observation-snapshots.ts` |
| Live Y.Doc coordination | `adapters/hocuspocus-coordinator.ts` |
| Branch rows and branch state | `adapters/drizzle-branches.ts`, `domain/branch-coordinator.ts` |
| Thread-peer agent-edit binding | `domain/branch-agent-edit.ts` |
| Live→branch pull propagation | `domain/branch-pulls.ts` |
| Critical sections | `domain/branch-critical-sections.ts` |
| Push plan + conflict policy | `domain/branch-push-plan.ts` |
| Trail projection | `domain/branch-trail-projection.ts` |
| Durable push execution | `domain/branch-push-executor.ts`, `adapters/drizzle-branch-push.ts` |
| Discard/undo/redo | `domain/branch-review.ts`, `domain/branch-review-operations.ts` |
| Trail persistence port + aggregate writer | `domain/ports/change-trail-persistence.ts`, `adapters/drizzle-change-trail-aggregate.ts` |
| Trail delivery/work/reconciliation | `adapters/drizzle-change-trail-dispatcher.ts`, `adapters/change-trail-worker.ts`, `adapters/drizzle-change-trail-reconciler.ts` |
| Review diff/cards | `domain/draft-review-hunks.ts`, `domain/branch-review-closure.ts` |
| Hocuspocus persistence | `hocuspocus-persistence.ts` |
| Offline late reconciliation | `domain/offline-reconciliation.ts` |
| Safety-notice production + writer delivery | `composition.ts`, `routes/ws/yjs.ts`, `domains/notices/` |

## Write codec and schema coherence

`domain/markdown-document.ts` is the single content write/read and Y.Doc
projection engine. It resolves each document's filetype (composition-root
resolver injected in `composition.ts`) before every parse or serialization:
`document` → markdown codec; `code` → one `code_block` holding the raw text
verbatim (`language` = filetype), read back without fences. Checkpoint restore,
branch/effective reads, and review previews use this document-aware surface;
schema-blind serialization is private to the engine.

Filetype resolution uses the contracts disposition registry. Missing or
unregistered persisted values deliberately use the document schema; a registered
binary/custom value on a tracked journal returns `corrupt_state` from
Result-returning surfaces instead of escaping as a rejected promise.

Invariant: a document's journal state must always be valid under the schema the
client mounts for its filetype. Issue #196 exposed the historical failure mode:
markdown-only seeding produced schema-invalid content that ProseMirror silently
deleted on first open, then persisted that deletion. The current engine is
schema-aware; all new seed and write paths must go through it rather than
hand-building fragment content. The context caller contract is documented in
[the context domain](../../context/.context/CONTEXT.md).

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
- `model_response_observation_snapshots` and its entry table store immutable,
  full-Yjs-identity evidence sealed to successful model responses. Agent-authored
  live journal, mutation, and reversal rows have an authoring-response FK seam.

The deleted legacy draft tables (`document_yjs_drafts`,
`document_yjs_draft_updates`) are not part of the model.

Initial live sync-step-2 integration is the offline-reconciliation hook. It
captures the converged state before asynchronous persistence work, replays the
durable journal for origin and structural-delete attribution, and judges the
removed canonical block identity through the response ObservationSnapshot.
Reports use the ordinary swept change-trail shape; missing ancestry/body/owner
evidence emits degradation telemetry rather than guessing from update bytes.

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
- **Sorted push locks**: `BranchCriticalSections` acquires branch locks in
  branch-id order, then live coordinator locks in document-id order.
- **One push commit seam**: whole, selective, and companion pushes execute via
  `branch-push-executor.ts`; a durable commit requires its trail bundle.
- **One trail write seam**: recording and reconciliation delegate aggregate
  mutation to `drizzle-change-trail-aggregate.ts`. Dispatch, work claiming, and
  reconciliation do not duplicate aggregate SQL.
- **Draft Apply base**: every branch journal row captures the live journal head
  as immutable `draftBaseUpdateSeq` when the row is inserted. Apply judges a
  selected set from its oldest row base, refuses human-origin overwrite/delete
  and protected resurrection, and never rebases rows after a click or refusal.
- **Push policy is the only mode difference**: manual Apply refuses protected
  draft-base divergence. Auto-apply always merges; only blind destructive
  effects are trailed, using the authoring response's sealed ObservationSnapshot
  and the shared `observationCoversRendering` predicate.
- **Late-sweep receipts**: response finalization records a thread-scoped,
  writer-visible `late_sweep` notice with the before-state journal reference and
  a captured body for every swept hash. Hocuspocus forwards writer-visible
  notices as stateless `safety_notice` messages; model delivery drains the same
  notice port rather than a parallel result channel.
- **Response-scoped thread-peer atomicity**: `domain/response-transaction.ts`
  settles cache publication, watermarks, facade ownership, and response lifecycle
  against the actual ambient Drizzle commit or rollback. The real-Postgres
  `response-transaction-atomicity.db.test.ts` proves a failed
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
