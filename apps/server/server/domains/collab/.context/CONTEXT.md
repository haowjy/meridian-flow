# collab — branch-backed document infrastructure

The server collab domain supplies concrete Postgres/Hocuspocus adapters around
`@meridian/agent-edit` and exposes `CollabDomain` to routes, runtime, context,
and WebSocket callers.

## Current shape

| Concept | Canonical name | Code surface |
|---|---|---|
| Durable `document_yjs_heads` row and its fenced journal prefix | **document authority head** | `DocumentAuthorityHead`, `DocumentAuthorityId`, `document_yjs_heads` |
| Operation-specific capabilities that validate and admit content-bearing mutations | **document mutation policy** | `admitFreshAuthorship`, `admitCertifiedMutation`, `replicateFrozenIdentity`, `replaceAuthorityGeneration` |
| Mutable `Y.Doc` held by a loaded Hocuspocus room | **live document** | `liveDocument` / `liveDoc` in room and Hocuspocus surfaces |

“Document authority” is reserved for the durable head and its identity/generation.
Do not use it for the mutation policy or an in-memory `Y.Doc`. The policy uses
the neutral `MutationTarget` for branch, scratch, and live inputs; only room-owned
state is a live document.

## Write codec and schema coherence

`domain/markdown-document.ts` is the single content write/read and Y.Doc
projection engine. It resolves each document's filetype (composition-root
resolver injected in `composition.ts`) before every parse or serialization:
`document` → markdown codec; `code` → one `code_block` holding the raw text
verbatim (`language` = filetype), read back without fences. Checkpoint restore,
branch/effective reads, and review previews use this document-aware surface;
schema-blind serialization is private to the engine.

**Durable whole-document projections route through this engine.** Push
completion derives the projection at settlement through
`DurableProjectionSerializer`; `PreparedPushCommit` must not carry a prepared
markdown projection or live snapshot. This keeps serialization inside the
fenced settlement cut and preserves verbatim code-document output.

**Projection effects preserve caller-specific ordering.** Ordinary durable
writes start document activity and markdown projection together and settle both
before reporting the first failure. Push completion instead runs projection,
all-thread activity, explicit Work activity, active-document project lookup, and
project activity in that order. The Drizzle adapter resolves the ambient
transaction for every port operation so a completion retry rolls these
read-model writes back with journal, lineage, mutation, and outbox writes.

Filetype resolution uses the contracts disposition registry. Missing or
unregistered persisted values deliberately use the document schema; a registered
binary/custom value on a tracked journal returns `corrupt_state` from
Result-returning surfaces instead of escaping as a rejected promise.

Invariant: a document's journal state must always be valid under the schema the
client mounts for its filetype. All seed and write paths go through the
schema-aware engine rather than hand-building fragment content. A new
document's first seed is installed as its
generation-1 checkpoint with no admitted journal mutations. Seeding is strictly initialize-only: any
existing admission or checkpoint makes later attempts successful no-ops. A seed
is reconciled into an already-open live room before success returns, and a stale
room checkpoint at the same journal cut cannot replace it. The context caller contract is documented in
[the context domain](../../context/.context/CONTEXT.md).

## Branch model

Branches are real Y.Docs. A thread peer starts from the Work draft, receives live
pulls by CRDT sync, and stages agent writes. The Work draft is the writer review
branch. There is at most one active Work-draft branch per
`(documentId, workId)`; every thread peer for that document and Work shares it
as upstream. Pushing computes a Yjs update from branch to live, records push
lineage, marks source journal rows reviewed, and resets/advances branch
generation where needed.

The review list therefore emits one active item per document and folds all
contributing journal rows into that item. `lastActorTurnId` is representative
metadata, not review identity. `draftId` is the only application and wire
identity. `WorkDraftReviewService` resolves it to the physical Work branch and
keeps that branch identity inside the domain; `reviewRoomName` remains an opaque
transport address.

Propagation is sync-only. Cold attribution uses persisted branch journal rows
and live journal metadata; memory-only runtime maps are never an attribution
authority.
Live→Work-draft pulls run after persisted live updates (2-second debounce, 10-second
maximum), on branch review room open/reconnect, and at agent tool boundaries. The
room trigger is fire-and-forget; Hocuspocus admission never waits for the pull. Once
durable, pull deltas use the branch coordinator's existing update publisher so loaded
Hocuspocus branch rooms converge and broadcast normally; unloaded branches remain
persistence-only.

**Branch mutations are durable before they reach a Hocuspocus room.** A draft
branch room is a collaborative room: writer frames from a review editor are
admitted like any other peer's, alongside server-side agent and disposition
commands. No branch-room `onStore` path may re-persist or re-checkpoint to make
a mutation durable — it already is. Live and branch writer frames use the same
sequence: authority/generation validation, exact-containment acknowledgement,
fresh-authorship validation, then durable append. Branch admission runs that
sequence against one locked branch snapshot through the awaited `beforeSync`
hook, before Hocuspocus apply/broadcast/ack. `onChange` does not own branch
persistence. `admitBranchWriterUpdate` registers the whole admission with
`trackAppend` before validation's first `await`, so a `storeHocuspocusBranch` or
graceful-shutdown drain cannot miss an admission Hocuspocus is already
processing — do not move registration after an `await`.
`storeHocuspocusBranch` only drains pending branch admissions; calling
`checkpointBranch` (or any `withBranches`) from it re-enters the publisher's
`AsyncLocalStorage` branch-lock context and throws (`branch-critical-sections.ts`
rejects overlap on sight).

The Yjs route owns only upgrade authentication, CrossWS peer adaptation, and
gateway delegation. `lib/yjs-ws-handler.ts` owns connection state, admission,
Hocuspocus lifecycle hooks, and graceful drain; transport changes must preserve
the admission ordering above and keep `beforeSync` awaited. The gateway is a
synchronous process singleton: authenticated upgrade captures it in the peer
context, and `open`/`message`/`close`/`error` must dispatch through that
instance without a lookup `await`. Startup retains that same instance so
shutdown calls `drain()` before its first await; `drain()` closes admission
synchronously before waiting for persistence.

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

Manifest membership rows are branch bookkeeping, not writer-reviewable prose.
`domain/work-draft-pending.ts` owns the pending Work-draft predicate used by
review lists, counts, and Auto-apply confirmation: it requires current-generation
reviewable rows loaded through the `WorkDraftPendingStore` seam and excludes
`manifest_membership` rows. Its Drizzle adapter loads all evidence in one joined
query and projects only the classification fields (`turnId` and `updateMeta`);
ordinary counts and lists must not read full Yjs payloads. Counts are reviewable
content branches (one per document), never raw journal-row totals. The authority
still associates an excluded manifest entry with its content draft so confirmed
Auto-apply publishes new-document content and live membership atomically. A
reusable manifest Work-draft branch may remain `active` after its content
companions settle; that status alone is not pending-review evidence.

`domain/document-creation.ts` owns tracked-document materialization
transactions. Context and bootstrap supply the row, initial-content, and
manifest operations; the aggregate commits them together. Repair uses the same
boundary so a row cannot become visible before its Yjs authority is usable.
Initial-content and live-manifest recovery publish to warm Hocuspocus rooms only
after the enclosing Drizzle transaction commits. Work/thread manifest mutations
persist their branch state inside that transaction and defer the automatic live
push until commit.

## Durable records

- `document_yjs_updates` is the live update journal.
  Writer rows persist as `origin_type = human`; reads also normalize legacy
  `user` rows to the package's `human:<actor>` origin. Reversal and bookkeeping
  rows keep `origin_type = system`, and reversal rows store independent
  `reversal_actor_type` attribution. Agent rows persist as `agent`. A branch
  settlement appends its exact authored rows followed by one `reconcile` row
  carrying the canonical pushed update; the latter supplies replay coverage,
  not a later semantic edit. Only the writer class invalidates a live reversal
  plan.
- `document_branches` stores branch snapshots/state vectors/generation.
- `branch_write_journal` stores branch write rows and review status.
- `push_lineage` stores publication identity, typed branch generation, and
  idempotency lineage. The change trail is the sole durable publication record;
  lineage never duplicates block diffs.

Human-origin edits produce one journal row per keystroke. A 50-character
sentence becomes ~50 rows / ~935 bytes. This is expected: checkpoint compaction
recovers storage, and journal row counts are not equivalent to semantic edits.
Reconnect frames already contained by the live document are acknowledged but
do not enter the journal or trigger post-persistence hooks.

Novel live sync-step-2 integration is the offline-reconciliation hook. It
captures the converged state before asynchronous persistence work, replays the
durable journal for origin and structural-delete attribution, and reports each
removed writer-owned canonical block identity. Missing ancestry/body/owner
evidence emits degradation telemetry rather than guessing from update bytes;
it does not make the optional mark overlay authoritative.

## Undo guard and push safety

`reverseThreadContext` is the route-facing reversal command. It owns the choice
between context-document and turn-lineage reversal, write-handle parsing,
projection refresh, and aggregate result status; the HTTP route only authenticates,
validates its transport body, invokes the command, and serializes the result.
For compatibility, a top-level array, primitive, or `null` body is normalized
to `{}` before validation and returns `400 direction must be undo or redo`.
`TurnReversalServiceDeps` is total: each composition supplies its dependencies
or the declared unsupported stubs; do not restore optional dependencies that
fail only when a command reaches them.

- **Live receipt reversal state uses the command planner**:
  `drizzle-turn-receipt.ts` asks agent-edit `planUndo` and `planRedo` for each
  live document instead of projecting availability from mutation status.
  Command execution uses the same planners. The planner rejects redo after a
  later writer (`human:*`) row but ignores the undo's system row, other system
  bookkeeping, and later agent rows. Persist-time guards repeat the writer-only
  watermark check under the document lock, covering a writer admission between
  planning and persistence. Active Work-draft receipt and command paths both use
  `branch-turn-reversal-plan.ts`; its authority is branch generation, journal
  status, dependency analysis, and successful peer reconstruction. Undo treats
  both `active` and `rollback_pending` rows as current effects; redo rebuilds
  from active survivors plus only the selected discarded target.
- **Receipt command unavailable states are semantic outcomes**: the reverse endpoint may
  return `nothing_to_undo`, `nothing_to_redo`, `cant_undo_dependent`, `expired`,
  or `partial` with HTTP 200 when state races the projection. The app invalidates
  the turn query after the command and retains the raced reason while the receipt
  changes to its unavailable state; callers must not discard these outcomes.
- **Canonical reversal is live-scoped**: hosted `reverse()` uses the live utility
  core, never the thread-peer branch committer. The host captures a live Yjs
  snapshot and live-journal sequence together before entering agent-edit.
- **Work-draft write-command reversal is branch-scoped**: while the current Work-draft
  generation has agent rows for the thread, `write(command="undo"|"redo")`
  reconstructs and stages reversals exclusively from those rows. The staged
  system row carries the Work-draft generation and becomes durable in the same
  branch commit that projects its Yjs update; it never writes the live journal.
  The command pins one branch scope from planning through persistence, and cold
  replay is reconciled to the authoritative branch snapshot.
  The commit also checks the planned branch-journal watermark and status revision
  under the branch snapshot CAS, so appended rows and status-only Apply/review
  transitions both reject the stale reversal for replanning.
  After Apply advances to an empty generation, reversal lookup falls back to the
  live store so pushed writes retain their normal undo path.
- **Turn reversal is durable-atomic and runtime-staged**: production persists
  branch and live changes in one ambient Drizzle transaction. Across distinct
  documents, a no-op or unavailable result mixed with success makes the aggregate partial
  and aborts the whole transaction. Duplicate branch/live results for the same
  document are folded first, so one successful scope plus its no-op peer remains
  successful. Branch broadcasts, live Y.Doc application, runtime synchronization,
  and projection refresh run only after commit, with per-document journal
  recovery; rollback publishes none of them. Cross-room publication is
  serialized, not a simultaneous transport primitive. Branch candidates are
  restricted to the command's authorized document set.
- **Work-draft handles name durable response groups**: response buffering and branch
  projection fold all same-document mutations in one response into one
  `branch_write_journal` row. Every write in that group therefore receives the
  same `w<N>` handle. Selectors operate on durable rows, not transient tool-call
  boundaries; redo may further group handles that share one atomic reversal
  update. This matches the folded, turn-scoped diff contract rather than
  advertising per-write identity the journal does not retain.
  Apply materializes only handles whose final branch state is active; handles
  eliminated by Work-draft write reversal are squashed rather than recreated as active live
  mutations for content that is absent. Each surviving branch journal row keeps
  its own live update identity and attribution. Writer rows therefore remain
  visible to the dependency predicate instead of being folded into an AI
  mutation or representative push author.
- **Intrinsic undo guard**: `persistUndo` in `adapters/drizzle-journal.ts` runs
  the dependency check (`hasDependentLaterRows` in
  `domain/journal-dependencies.ts`) inside the same transaction, under
  `lockDocumentMutation` advisory lock. There is
  no separate live `ReversalCommitGuard`. Work-draft reversal uses the generation and
  journal-watermark fence above.
- **Tombstone cap**: `gc: false` on all branch `Y.Doc` instances — full struct
history is preserved for attribution, echo, and undo dependency checking.
- **Sorted push locks**: `BranchCriticalSections` acquires branch locks in
  branch-id order, then live coordinator locks in document-id order.
- **One push commit seam**: whole-content and manifest-companion builders
  produce a `CandidateBatch` consumed by the single pipeline in
  `branch-push.ts`. Content candidates always materialize the whole current
  branch. Only the internal manifest candidate selects membership rows. Locked
  preparation in `branch-push-preparation.ts` computes one block diff from the
  live lock cut; `branch-trail-projection.ts` turns it into the sole durable
  publication record, while typed `push_lineage.branch_generation` supports
  generation-local idempotency queries without duplicating that diff.
  `branch-push-transition.ts` alone orders capture
  through fenced completion. The transition projects the aggregate writer's exact
  committed replace-set and delivers it to connected bare-document rooms only
  after the completion fence reports applied/already-applied. Delivery is a
  session-local hint: it is not queued or replayed, and a vanished room cannot
  fail an otherwise durable push. A durable commit requires its trail bundle. Review
  reversal is a separately composed
  `branch-review-operations.ts` service.
  Projection failure is classified: only the canonical `DocumentSyncError` with
  `code: "corrupt_state"` (a registered non-tracked filetype on a tracked
  journal) permanently blocks live settlement via `PendingSettlementStore.block`;
  transient serializer failures propagate but leave the settlement retryable.
  Do not block on every projection throw.
- **One trail write seam**: recording and reconciliation delegate aggregate
  mutation to `drizzle-change-trail-aggregate.ts`. It is also the sole interpreter
  of `TrailContributionReplacement`; settlement carries the replacement opaquely.
  Each replacement carries its durable per-owner changes and document-title
  context. Never recover that context from surviving aggregate rows: an intervening
  fold can remove every provisional row before settlement must restore the
  push contribution. The aggregate counts inserted/deleted payloads and persists
  per-document word magnitudes; lightweight shells retain document ids/titles
  plus nullable totals so receipt headers never need manuscript-bearing detail.
  Dispatch, work claiming, and reconciliation do not duplicate aggregate SQL.
- **Trail detail authorization precedes detail materialization**: the reader
  resolves each occurrence to `available`, `deleted`, or denied before selecting
  manuscript-bearing title/prose. Denied occurrences disappear; authorized
  deleted anchors retain evidence under an explicit `anchorState`.
- **Trail block identity**: durable changes carry document-scoped Yjs
  `{clientID, clock}` identities. Change IDs, folding, dedupe, and destructive
  evidence use that canonical identity; hash prefixes are display-only. The
  wire contract always includes both `beforeBlockIdentity` and
  `afterBlockIdentity` keys; each value is nullable for the absent side of an
  insertion or deletion, while canonical folding requires at least one identity.
  Display block IDs and a constant `reversible` flag are not part of the durable
  trail contract.
  `branch-trail-projection.ts` may repair exact content relocation across a
  chain of shifted block identities only when the evidence forms a one-to-one
  path ending in one terminal deletion. It projects the chain head as the
  deletion and suppresses intermediate shifts. Proven structural replacement
  evidence takes precedence, so its source cannot also participate in a
  relocation. Fan-in, duplicate-source, cycle, or otherwise ambiguous evidence
  falls back to ordinary per-block changes; projection never guesses a
  relocation.
- **Trail evidence is read-only**: durable Before/After excerpts support
  disclosure and navigation but cannot mutate the manuscript. Receipt Undo/Redo
  is the sole reversal authority for AI changes.
- **Draft Apply settles the whole current branch**: every writer Apply and
  auto-push integrates through Yjs. `draftBaseUpdateSeq` is not Apply freshness
  authority; sweep policy uses each AI row's value only as that candidate's
  observation watermark. Each candidate is classified against the pre-push
  document plus earlier selected branch rows, and recipient/change elevations
  are unioned across candidates. Apply writes current branch rows into the live
  journal with their original attribution, then appends the complete push update
  as a `reconcile` row so cold replay includes causal dependencies omitted from
  active rows. Active agent handles materialize against their corresponding
  authored rows; reconciliation coverage is not a later semantic dependency.
  Handles eliminated by Work-draft write reversal remain absent. A later writer row can
  therefore make producing-turn Undo unavailable through the canonical
  dependency predicate.
  Push-time and immediate-path sweep detection derive their live-session hint
  from durable attribution, not push metadata or a separate protection table.
  Branch settlement keeps compact `{userId, rootsAfterObservationWatermark}`
  evidence and evaluates it against neutral target-to-root intervals; it does
  not reuse destructive-safety birth classes. The checkpoint state supplies a
  neutral covered-root floor, and authority-order replay assigns only
  previously unseen insertion ranges, so a later sync update cannot claim
  historical or AI roots it repeats. Materialization scans checkpoint metadata,
  loads only the distinct full states selected for candidate watermarks, and
  caches first-birth replay per checkpoint floor.
  Trail rows persist every edit without classification; missing evidence
  suppresses elevation and never blocks Apply.
- **Writer Apply is branch-scoped, not preview-scoped**:
  `DraftApplyRequest` names only the draft. The server pushes the
  complete current branch, including writer rows created after preview.
  Preview operations and revision tokens are presentation evidence, not command
  selection or freshness authority.
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
  pending/blocked/completed state. `PendingSettlementStore` is the required
  persistence authority for settlement, claims, failure backoff, blocking, trail
  refinement, and fenced completion. Exact post-cut Yjs admissions live in the
  normalized `branch_push_outbox_updates` relation. Journal and staged-push
  admission both call the single `joinAdmissionWithinTx` writer inside their
  document-mutation transaction; source identity and completing-push exclusion
  are parameters, while join-version advancement follows one SQL path. Cold
  reads best-effort reconstruct compact causal, actor-specific root evidence for
  the final pre-push document so each authenticated connected editor can elevate
  only its own overwritten post-observation edits. Delivery projects a
  recipient-specific boolean per connection rather than broadcasting recipient
  arrays; connections without an authenticated user identity receive no change
  event. Push admission identity does not transfer AI content authorship to the
  admitting writer.
  Provenance admission is root-unit injective: one protected root unit may have
  only one visible target, so divergent restoration or replication blocks rather
  than granting deletion credit to either copy.
  Root-effect materialization failure emits diagnostics and yields no swept
  elevation; it is never settlement authority. Settlement writes the complete
  push trail in its existing aggregate version; only journal or staged-push
  authority joined after the durable commit publishes another trail version. If
  that admission's aggregate fold cancels a provisional row, settlement restores
  the push contribution from the replacement's durable owner/title context.
- **Settlement verification stack**: the killed-process oracle owns durable
  settlement risks—transaction boundaries, claims and leases, lock cuts, crash
  windows, and cold recovery. Pure provenance and policy semantics belong to their
  focused owners rather than to a second PostgreSQL replay graph. The oracle is
  necessary but not sufficient: `lib/compose.runtime-settlement.db.test.ts` must
  also drive the real `createProductionAppPorts` + `composeAppServices` +
  Hocuspocus + worker-drain chain with production-shaped sync-step-2 full-state
  updates, and release probes must verify writer-visible trail flows.
- **Trail-work time**: retry eligibility, backoff, and abandoned-running leases
  use an injected schedule. Production obtains its time from PostgreSQL; tests
  advance a controlled schedule. Do not reintroduce process-clock comparisons or
  sleep-based lifecycle tests.
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
  composition binds settlement to the real DB outcome through an injected
  commit/rollback deferral capability.
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
  Yjs. Neutral target-to-root lineage plus compact first-origin writer evidence
  drives best-effort live sweep detection; destructive-safety provenance remains
  a separate conservative lifecycle classifier. Checkpoint manifests carry
  safety attribution across repeated compaction and floor-null authority
  replacement, while checkpoint state supplies sweep policy's neutral covered
  root floor. Under the same document-mutation lock as generation replacement,
  compaction reads, folds, and deletes only the current authority generation;
  retired-generation suffixes never enter restored authority. Durable trails
  retain the ordinary before/after record regardless of classification; writer
  lineage only decides whether an authenticated connected session elevates the
  mark.
## LOCK-WS boundary

`withDocument()` serializes coordinator callers, not writer WebSocket updates:
Hocuspocus can mutate the same in-memory Y.Doc while a coordinator callback is
awaiting journal or detection work. Any content apply after an `await` must use
the durable settlement row, and the live recheck and apply share one synchronous
fence. Writer admission is journal-first; optional sweep detection may degrade
to no elevation, but it never supplies apply authority.

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
