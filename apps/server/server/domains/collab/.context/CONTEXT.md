# collab — branch-backed document infrastructure

The server collab domain supplies concrete Postgres/Hocuspocus adapters around
`@meridian/agent-edit` and exposes `CollabDomain` to routes, runtime, context,
and WebSocket callers.

## Current shape

| Concept | Canonical name | Code surface |
|---|---|---|
| Durable `document_yjs_heads` row and its fenced journal prefix | **document authority head** | `DocumentAuthorityHead`, `DocumentAuthorityId`, `document_yjs_heads` |
| Capability that validates and admits content-bearing mutations | **document mutation policy** | `DocumentMutationPolicy`, `createDocumentMutationPolicy`, `domain/document-mutation-policy.ts` |
| Mutable `Y.Doc` held by a loaded Hocuspocus room | **live document** | `liveDocument` / `liveDoc` in room and Hocuspocus surfaces |

“Document authority” is reserved for the durable head and its identity/generation.
Do not use it for the mutation policy or an in-memory `Y.Doc`. The policy uses
the neutral `MutationTarget` for branch, scratch, and live inputs; only room-owned
state is a live document.

| Concern | Location |
|---|---|
| Document mutation policy | `domain/document-mutation-policy.ts` |
| Durable authority heads and generation fencing | `domain/ports/document-authority-heads.ts`, `adapters/drizzle-document-authority-head.ts` |
| Live Yjs journal/checkpoints/reversal metadata | `adapters/drizzle-journal.ts` |
| Live Y.Doc coordination | `adapters/hocuspocus-coordinator.ts` |
| Branch rows and branch state | `adapters/drizzle-branches.ts`, `domain/branch-coordinator.ts` |
| Thread-peer agent-edit binding | `domain/branch-agent-edit.ts` |
| Draft undo/redo history and Apply folding | `domain/branch-reversal-history.ts` |
| Live→branch pull propagation | `domain/branch-pulls.ts` |
| Critical sections | `domain/branch-critical-sections.ts` |
| Push materialization | `domain/branch-push-plan.ts` |
| Immutable-base Manual Apply policy | `domain/branch-push-preparation.ts` |
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
generation-1 checkpoint with no admitted journal mutations. Seeding is strictly initialize-only: any
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
Live→Work-draft pulls run after persisted live updates (2-second debounce, 10-second
maximum), on branch review room open/reconnect, and at agent tool boundaries. The
room trigger is fire-and-forget; Hocuspocus admission never waits for the pull. Once
durable, pull deltas use the branch coordinator's existing update publisher so loaded
Hocuspocus branch rooms converge and broadcast normally; unloaded branches remain
persistence-only.

**Branch mutations are durable before they reach a Hocuspocus room.** No branch-room
`onStore` path may re-persist or re-checkpoint to make a mutation durable — it already
   is. Live and branch writer frames use the same sequence: authority/generation
   validation, exact-containment acknowledgement, fresh-authorship validation,
   then durable append. Branch admission runs that sequence against one locked
   branch snapshot through the awaited `beforeSync` hook, before Hocuspocus
   apply/broadcast/ack. `onChange` does not own branch persistence.
`admitBranchWriterUpdate` registers the
whole admission with `trackAppend` before validation's first `await`, so a
`storeHocuspocusBranch` or graceful-shutdown drain cannot miss an admission
Hocuspocus is already processing — do not move registration after an `await`.
`storeHocuspocusBranch` only drains pending branch admissions; calling
`checkpointBranch` (or any `withBranches`) from it re-enters the publisher's
`AsyncLocalStorage` branch-lock context and throws (`branch-critical-sections.ts`
rejects overlap on sight). Pinned by the `storeHocuspocusBranch` re-entry regression
test; the prior redundant checkpoint surfaced only in a live loaded-room probe, not
`pnpm check`.

## Live manifest membership

The project manifest's `documents` Y.Map is the membership authority used by the
live-room gate. Ordinary `resolveManifestMembership` calls never reconcile or
append membership history. `reconcileProjectManifest` is the additive-only, cross-replica-serialized
self-heal command: it seeds missing active database content rows, but never
rewrites an existing key or removes an entry. The WebSocket gate invokes it once
after a membership miss. Manifest write-intent paths do not run this broad SQL
reconciliation; draft-scoped creation (`workId` or `threadId`) must not allow
unstaged document rows to enter live membership. Creation and deletion flow
through `recordManifestDocument{Created,Deleted}`, with SQL
soft-delete committed before the deletion notification. Preserve every no-op guard:
setting an equal Y.Map value still creates Yjs history. See
[KB: Manifest Membership Port](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/manifest-membership-port.md)
for the cross-domain port decision and self-healing rationale.

## Durable records

- `document_yjs_updates` is the live update journal.
  Reversal rows keep `origin_type = system` for redo classification and store the
  independent `reversal_actor_type` attribution used by other sessions.
- `document_branches` stores branch snapshots/state vectors/generation.
- `branch_write_journal` stores branch write rows and review status.
- `push_lineage` records pushes to live and receipts.

Human-origin edits produce one journal row per keystroke. A 50-character
sentence becomes ~50 rows / ~935 bytes. This is expected: checkpoint compaction
recovers storage, and journal row counts are not equivalent to semantic edits.
Reconnect frames already contained by the live document are acknowledged but
do not enter the journal or trigger post-persistence hooks.

The deleted legacy draft tables (`document_yjs_drafts`,
`document_yjs_draft_updates`) are not part of the model.

Novel live sync-step-2 integration is the offline-reconciliation hook. It
captures the converged state before asynchronous persistence work, replays the
durable journal for origin and structural-delete attribution, and reports each
removed writer-owned canonical block identity.
Reports use the ordinary swept change-trail shape; missing ancestry/body/owner
evidence emits degradation telemetry rather than guessing from update bytes.

## Undo guard and push safety

- **Canonical reversal is live-scoped**: hosted `reverse()` uses the live utility
  core, never the thread-peer branch committer. The host captures a live Yjs
  snapshot and live-journal sequence together before entering agent-edit.
- **Draft write-command reversal is branch-scoped**: while the current Work-draft
  generation has agent rows for the thread, `write(command="undo"|"redo")`
  reconstructs and stages reversals exclusively from those rows. The staged
  system row carries the Work-draft generation and becomes durable in the same
  branch commit that projects its Yjs update; it never writes the live journal.
  The command pins one branch scope from planning through persistence, and cold
  replay is reconciled to the authoritative branch snapshot so selective review
  remains represented even though reviewed rows stay in the generation history.
  The commit also checks the planned branch-journal watermark and status revision
  under the branch snapshot CAS, so appended rows and status-only Apply/review
  transitions both reject the stale reversal for replanning.
  After Apply advances to an empty generation, reversal lookup falls back to the
  live store so pushed writes retain their normal undo path.
- **Draft handles name durable response groups**: response buffering and branch
  projection fold all same-document mutations in one response into one
  `branch_write_journal` row. Every write in that group therefore receives the
  same `w<N>` handle. Selectors operate on durable rows, not transient tool-call
  boundaries; redo may further group handles that share one atomic reversal
  update. This matches the folded, turn-scoped diff contract rather than
  advertising per-write identity the journal does not retain.
  Apply materializes only handles whose final branch state is active; handles
  eliminated by Draft undo are squashed rather than recreated as active live
  mutations for content that is absent. Because one Apply is one durable live
  update, all handles materialized by that Apply form one live undo boundary:
  selecting any of them expands to the full group and marks the group together.
- **Intrinsic undo guard**: `persistUndo` in `adapters/drizzle-journal.ts` runs
the dependency check (`hasDependentLaterRows` in `domain/journal-dependencies.ts`)
inside the same transaction, under `lockDocumentMutation` advisory lock. There is
no separate live `ReversalCommitGuard`. Draft reversal uses the generation and
journal-watermark fence above.
- **Tombstone cap**: `gc: false` on all branch `Y.Doc` instances — full struct
history is preserved for attribution, echo, and undo dependency checking.
- **Sorted push locks**: `BranchCriticalSections` acquires branch locks in
  branch-id order, then live coordinator locks in document-id order.
- **One push commit seam**: whole, selective, and companion pushes execute via
  `branch-push-executor.ts`; immutable-base conflict preparation lives in
  `branch-push-preparation.ts`, trail and notice projection live in
  `branch-trail-projection.ts`, and `branch-push-transition.ts` alone orders
  capture through fenced completion. A durable commit requires its trail bundle.
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
  draft-base divergence; Auto-apply always merges. Protection derives from
  durable journal attribution: `completeStagedPush` persists the live journal
  row as `originType: "human"` with `actorUserId` when the push carries
  `pushedByUserId` (writer-confirmed Apply); Auto-apply pushes (no
  `pushedByUserId`) stay `system`. Both the push-time conflict classifier and
  the agent-edit immediate-path lateSweep recheck derive protection from this
  attribution, not from push-specific metadata or a separate protection table.
  Auto-apply trails destructive writer-root effects from durable provenance.
  This reporting classification is independent of the row's Apply-only draft
  base.
- **Writer Apply pins to the displayed preview**: `DraftAcceptRequest.operationIds`
  is required (non-optional). The client pins Apply-all to the displayed preview
  via a render-time ref, never a click-time refetch; post-preview rows stay
  pending. Composition routes all writer Apply through `pushSelectedToLive`;
  the `whole` push kind remains for Auto-apply/retry but is unreachable from
  writer Apply. On `push_concurrent_conflict`, composition maps the result to
  ordinary `concurrent_conflict` and the client re-reviews with a fresh preview.
- **Writer ingress barrier**: `beforeSync` consumes Hocuspocus's decoded sync
  type/payload once. After fencing and provenance validation, a cached,
  mutation-invalidated Yjs snapshot performs exact delete-set-aware containment;
  struct novelty takes the state-vector fast path without constructing a
  history-sized snapshot. Already-contained updates are acknowledged without
  admission. Novel live updates are journaled through the narrow writer-ingress
  capability and joined to unresolved settlements before Hocuspocus
  apply/broadcast/ack. The domain seam drains started admissions and detects
  later admission generations.
  `pnpm --filter @meridian/server perf:writer-admission` is the manual performance
  gate; cached containment must retain at least a 10x p50 advantage over rebuilding
  a history-sized Yjs snapshot.
- **Push settlement state**: the outbox stores binary `lock_cut_update` and
  `push_update`, validated trail JSON, fenced ownership fields, and typed
  pending/blocked/completed state. Exact post-cut Yjs admissions live in the
  normalized `branch_push_outbox_updates` relation; admission association and
  `join_version` advancement share the document mutation transaction. Cold reads
  reconstruct durable provenance for the final pre-push document and feed its
  visible occurrences to the shared pointwise destructive-effect classifier.
  Provenance admission is root-unit injective: one protected root unit may have
  only one visible target, so divergent restoration or replication blocks rather
  than granting deletion credit to either copy.
  Swept trail details retain the normalized final-pre-push target ranges and exact
  final-pre-push body. Settlement refines a complete provisional push trail in its
  existing aggregate version; only journal or staged-push authority joined after
  the durable commit publishes another trail version. A complete empty
  classification removes that push's provisional changes in the same version.
- **Settlement verification stack**: the shared killed-process oracle in
  `test-support/durable-settlement-oracle.ts` is the exhaustive protocol layer.
  Fixtures run a warm control, stop an identical subject at the durable commit
  boundary, destroy all warm Y.Docs/coordinators/facades, rebuild from PostgreSQL,
  recover, and compare normalized trail, bodies, identities, eligible ranges,
  apply/completion, and forward actions. It is necessary but not
  sufficient: `lib/compose.runtime-settlement.db.test.ts` must also drive the real
  `createProductionAppPorts` + `composeAppServices` + Hocuspocus + worker-drain chain
  with production-shaped sync-step-2 full-state updates, and S2/S10 release probes
  must verify the writer-visible Restore/Copy and trail flows. Fixture deltas once
  passed the full oracle while repeated full-state structs broke first-birth
  attribution.
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
  `awareness_degraded` notice. They do not create process-local reporting authority.
- **Report-only agent commits**: direct writes and reversals always merge through
  Yjs. `materializeDestructiveProvenance` reconstructs exact durable writer/agent
  lineage for the shared destructive-effect classifier. Checkpoint manifests
  carry prior attribution across repeated compaction and floor-null authority
  replacement. Under the same document-mutation lock as generation replacement,
  compaction reads, folds, and deletes only the current authority generation;
  retired-generation suffixes never enter restored authority. Thread-peer roots
  absent from the live document are agent-owned branch content. Only writer-lineage
  loss produces captured bodies, trail data, and Restore; agent-only loss is
  silent.
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
