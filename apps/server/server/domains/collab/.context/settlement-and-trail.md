# Collab — push settlement and change trail

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
