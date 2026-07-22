# collab — branch-backed document infrastructure

The server collab domain supplies concrete Postgres/Hocuspocus adapters around
`@meridian/agent-edit` and exposes `CollabDomain` to routes, runtime, context,
and WebSocket callers.

## Current shape

| Concern | Location |
|---|---|
| Document mutation policy and generation fencing | `domain/document-authority.ts`, `adapters/drizzle-document-authority.ts` |
| Live Yjs journal/checkpoints/reversal metadata | `adapters/drizzle-journal.ts` |
| Response observation snapshots | `adapters/drizzle-observation-snapshots.ts` |
| Live Y.Doc coordination | `adapters/hocuspocus-coordinator.ts` |
| Branch rows and branch state | `adapters/drizzle-branches.ts`, `domain/branch-coordinator.ts` |
| Thread-peer agent-edit binding | `domain/branch-agent-edit.ts` |
| Live→branch pull propagation | `domain/branch-pulls.ts` |
| Critical sections | `domain/branch-critical-sections.ts` |
| Push plan + conflict policy | `domain/branch-push-plan.ts` |
| Trail projection | `domain/branch-trail-projection.ts` |
| Durable push execution | `domain/branch-push-executor.ts`, `domain/branch-push-transition.ts`, `adapters/drizzle-branch-push.ts` |
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
hand-building fragment content. A new document's first seed is installed as its
generation-1 checkpoint (with no admitted journal mutations, so its initial
causal cut is `admittedThrough: 0`). Seeding is strictly initialize-only: any
existing admission or checkpoint makes later attempts successful no-ops. A seed
is reconciled into an already-open live room before success returns, and a stale
room checkpoint at the same journal cut cannot replace it. The context caller contract is documented in
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

## Live manifest membership

The project manifest's `documents` Y.Map is the membership authority used by the
live-room gate. `reconcileLiveManifest` is additive-only and idempotent: it seeds
missing database content rows, but never rewrites an existing key or removes an
entry. Creation and deletion flow through `recordManifestDocument{Created,Deleted}`.
Preserve every no-op guard: setting an equal Y.Map value still creates Yjs
history. See
[KB: Manifest Membership Port](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/manifest-membership-port.md)
for the cross-domain port decision and self-healing rationale.

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

Human-origin edits produce one journal row per keystroke. A 50-character
sentence becomes ~50 rows / ~935 bytes. This is expected: checkpoint compaction
recovers storage, and journal row counts are not equivalent to semantic edits.
Reconnect frames already contained by the live authority are acknowledged but
do not enter the journal or trigger post-persistence hooks.

The deleted legacy draft tables (`document_yjs_drafts`,
`document_yjs_draft_updates`) are not part of the model.

Novel live sync-step-2 integration is the offline-reconciliation hook. It
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
  `branch-push-executor.ts`; `branch-push-transition.ts` alone orders capture
  through fenced completion; a durable commit requires its trail bundle.
- **One trail write seam**: recording and reconciliation delegate aggregate
  mutation to `drizzle-change-trail-aggregate.ts`. Dispatch, work claiming, and
  reconciliation do not duplicate aggregate SQL.
- **Trail block identity**: durable changes carry document-scoped Yjs
  `{clientID, clock}` identities. Change IDs, folding, dedupe, and destructive
  evidence use that canonical identity; hash prefixes are display-only.
- **Trail forward actions**: `drizzle-trail-forward-actions.ts` validates retained
  relative-position evidence against the current live root and first stores a
  committed intent with its live-state fingerprint on the durable trail change.
  Only a guarded apply is promoted to a human-origin journal row and `applied`;
  rejected intents replan from current live state. Proven anchor loss settles
  `anchor_unavailable`; three live-state collisions settle the distinct
  `retry_exhausted` outcome. This same state machine recovers a crash between intent
  commit, live apply, and journal finalization without bypassing the guard. Captured
  bodies remain readable when the live document is unavailable; both terminal
  outcomes degrade to the client Copy fallback.
- **Draft Apply base**: every branch journal row captures the live journal head
  as immutable `draftBaseUpdateSeq` when the row is inserted. Apply judges each
  selected row against that row's own base, unions the resulting conflicts, and
  never rebases rows after a click or refusal.
- **Push policy is the only mode difference**: manual Apply refuses protected
  draft-base divergence. Auto-apply always merges; only blind destructive
  effects are trailed, using the authoring response's sealed ObservationSnapshot
  and the shared `observationCoversRendering` predicate. The response commit
  kernel seals canonical swept-block identities and captured bodies into the
  branch journal row's update metadata before persistence; push projection
  consumes that evidence independently of the row's Apply-only draft base.
- **Writer ingress barrier**: after fencing and provenance validation, updates
  already contained by the live authority are acknowledged without admission.
  Novel live updates are journaled and joined to unresolved settlements before
  Hocuspocus apply/broadcast/ack. The domain seam drains started admissions and
  detects later admission generations.
- **Push settlement authority**: the outbox stores binary `lock_cut_update` and
  `push_update`, validated lineage/trail JSON, fenced ownership fields, and typed
  pending/blocked/completed state. Exact post-cut Yjs admissions live in the
  normalized `branch_push_outbox_updates` relation; admission association and
  `join_version` advancement share the document mutation transaction. Cold reads
  resolve each sealed lineage item to its immutable response causal cut and
  observation rows, memoize replay per distinct cut, and feed the resulting
  provenance occurrences to the shared pointwise destructive-effect classifier.
  Provenance admission is root-unit injective: one protected root unit may have
  only one visible target, so divergent restoration or replication blocks rather
  than granting deletion credit to either copy.
  V3 tokens retain the affected writer roots regardless of observation; the
  classifier alone grants per-response credit by requiring both causal-cut
  inclusion and exact rendering coverage.
  Swept trail details retain the normalized final-pre-push target ranges and exact
  final-pre-push body. Settlement refines a complete provisional push trail in its
  existing aggregate version; only journal or staged-push authority joined after
  the durable commit publishes another trail version. A complete empty
  classification removes that push's provisional changes in the same version.
- **Settlement verification stack**: the shared killed-process oracle in
  `test-support/durable-settlement-oracle.ts` is the exhaustive protocol layer.
  Fixtures run a warm control, stop an identical subject at the durable commit
  boundary, destroy all warm Y.Docs/coordinators/facades, rebuild from PostgreSQL,
  recover, and compare normalized trail, bodies, identities, causal membership,
  eligible ranges, apply/completion, and forward actions. It is necessary but not
  sufficient: `lib/compose.runtime-settlement.db.test.ts` must also drive the real
  `createProductionAppPorts` + `composeAppServices` + Hocuspocus + worker-drain chain
  with production-shaped sync-step-2 full-state updates, and S2/S10 release probes
  must verify the writer-visible Restore/Copy and trail flows. Fixture deltas once
  passed the full oracle while the production observation adapter dropped causal
  cuts and repeated full-state structs broke first-birth attribution.
- **Response-scoped thread-peer atomicity**: `domain/response-transaction.ts`
  settles cache publication, watermarks, facade ownership, and response lifecycle
  against the actual ambient Drizzle commit or rollback. The real-Postgres
  `response-transaction-atomicity.db.test.ts` proves a failed
  multi-document flush leaves no durable or process-local residue and is retryable.
- **Generation replacement transport fence**: checkpoint restore installs the retained
  checkpoint and attribution manifest in a fresh authority generation, retires the warm
  Hocuspocus document without checkpointing it, and disconnects its clients. Each
  connection is bound to the generation it opened; stale sessions reject before journal,
  with retired-identity insertion and delete-set analysis as defense in depth.
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
- **Post-durability notice failures** are structured-logged and may emit a best-effort
  `awareness_degraded` notice. They do not create process-local safety authority;
  subsequent agent reversals rely on sealed response observations and fail closed when absent.
- **Human-only gate classification**: the destructive-write safety gate
  intersects the candidate's `deletedHashes` against concurrent
  HUMAN-origin touched hashes only (`humanTouchedHashes`). Other-agent
  edits do not trigger rejection — the safety promise is to prevent an agent
  from silently deleting a writer's work.
- **Observation-scoped agent reversal**: an agent undo/redo carries its successful
  authoring response ID. Missing document evidence is the blind empty-snapshot case;
  user reversals remain explicit current intent and do not use observation provenance.


## LOCK-WS boundary

`withDocument()` serializes coordinator callers, not writer WebSocket updates:
Hocuspocus can mutate the same in-memory Y.Doc while a coordinator callback is
awaiting journal or detection work. For any safety-relevant apply after an
`await`, final classification must come from the durable settlement row and the
live recheck and apply must share one synchronous fence. Writer admission is
journal-first; unexplained live-only divergence is an invariant failure, not
evidence that may be copied from memory.

The response phase-C path enforces this in
`@meridian/agent-edit`'s `applyCommittedUpdateWithRecheck`. Branch push also
enforces the invariant while holding sorted branch locks followed by sorted live
document locks. Reversal `executePrepared` snapshots around the durable write,
then delegates its final recheck and apply to `applyCommittedUpdateWithRecheck`.
Do not treat the coordinator mutex as coverage for WebSocket mutations.

- **Push LOCK-WS cut**: the first instruction in each live-document lock captures
  the complete Yjs update. The push transaction stores that immutable cut and its
  durable post-cut delta; warm execution reloads the row and uses the same
  final-pre-push materializer as cold recovery. Rechecks compare complete updates,
  never state vectors, so delete-only divergence is visible.
