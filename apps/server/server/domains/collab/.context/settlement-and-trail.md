# Collab — push settlement and change trail

## Apply as a content publication

Every Apply (item, named changes, Apply all) goes through
`domain/draft-publication.ts` `applyItems`, then `pushBranchesToLive`
(`domain/branch-push.ts`), one settlement batch, `settleBatch`
(`domain/branch-push-transition.ts`) and `completeBatch`
(`adapters/drizzle-pending-settlement.ts`). Every text member of that batch is a
**content member**: a merge of the change the writer saw into live's current text,
never a copy of draft bytes. Pure planning is `domain/draft-apply.ts`
(`planContentApply`): from the `Y.Snapshot` of the writer's review frame it rebuilds
the base and draft he looked at (branch docs keep full history), recomputes the
changes, composes the chosen ones (`scope: "item"` takes all, `scope: "changes"` the
named `changeIds`), and merges them into live with the rebase's own `rebase`. The
Apply wins a same-word conflict and the live text it replaced comes back as
`overrode`. It also returns the blocks the base moves to (the same merge against the
base the draft was last rebased to), as blocks and never bytes.

- **Staging** (`publish()`'s plan, then under leases). Before any lease, refs resolve
  through the identity module (an unaddressable item makes the command `stale`; a
  named-changes Apply on a whole-item item is `whole_item`) and every unfinished batch
  with a member on these documents settles (`settleUnfinished`): settlement takes the
  same leases and the lease lock is not re-entrant. Under the sorted branch leases
  then the live locks, each text item is checked in order: nothing still unfinished on
  its document, a base to compare with, the catch-up rebase on live's certified cut,
  the request frozen into `ContentMemberInput` (`push_lineage.apply_payload`; a
  snapshotless request takes `Y.Snapshot(branch)` here, so recovery after a crash
  never applies draft words written after staging), then the plan against the lock
  cut. A failure is a decided outcome, not an error: `failed` with `settlement_unfinished`,
  `base_uninitialized` or `merge_failed`, or `not_found` when the snapshot or a named
  change cannot be rebuilt. A decided `failed` or `not_found` item stages no member and
  its tree effects (reveal, restore, created-row drop) are excluded from the batch's
  `draft_tree` payload, so a created document is never revealed without the content
  its Apply asked for. A plan stages a member (a lineage row with
  `idempotency_key = content:${commandId}:${branchId}` and an outbox row). A plan that
  decides `already_live` at staging still stages a member whose live write is an empty
  Yjs update, so its base patch has a durable path; `not_found` and `failed` stage none.
- **Replan at settlement.** `settleBatch` loads the batch (every copy of the push
  update and trail is read before the transaction), and for each member rebuilds the
  final pre-push live (`lockCutUpdate` plus `postCutUpdates`). If anything joined, the
  live update and trail are recomputed from `apply_payload` against it; if live
  already reads that way the member is `already_live`. A live move since staging never
  refuses: the merge is recomputed. It then computes the **base patch** against the
  branch state read under the held lease (`BaseWrite`): the merged base is written into
  `review_base` as client 1 over that state. A branch that is no longer active gets no
  patch.
- **Completion** (`completeBatch`, one transaction under the Work, namespace and
  document locks). It checks `joinVersion` (a later join is `CompletionRetry`, so the
  loop replans), writes the replanned update and trail to the outbox row before any
  read that depends on them, runs the tree step's `beforeAdmission` (reveals hidden
  creates and restores live-deleted documents at their rows' current locations; holds
  clashes; no relocation), admits an applied member as one reconcile row from the
  merged text, withdraws an `already_live` member like a held one (no live write),
  writes a `patch` base through `writeBranchState` (so the Work projection sees the
  effect change), advances `base_revision` only when the merged base equals the merged
  live, runs `afterAdmission(outcomes)` (records arrivals, refreshes the catalog, drops
  created rows, composes and stores the command's result), the warm-state recheck, and
  marks the batch `completed`. Nothing is marked `pushed`. After commit, warm live
  rooms receive the replanned update and the text branch's room receives the base
  update. The reconcile row, the branch CAS, the tree effects, the command result and
  the batch state commit together: the base is never ahead of durable live. When the
  text branch closed before completion, an item Discard lets the live write stand and
  patches nothing; Discard all makes the tree step refuse `gone`, abandons the batch,
  and answers the command `gone`.
- **Never replay a stored base delta.** The base patch, late-peer recovery and the
  rebase all write as client 1. A pending batch without its leases (a crash, or the
  lease-growth handoff `DraftApplyPendingError`) lets writer typing trigger recovery
  that consumes client 1's next clock range; a staged delta replayed afterwards
  collides on struct ids and Yjs drops it silently. A base computed under the lease at
  completion has nothing to collide with.
- **Recovery** is the same `settleBatch` path from durable inputs only: `apply_payload`,
  the branch row, the outbox cut and its joins. A blocked batch stays blocked, and its
  document's rebases and Applies wait on it (`settlement_unfinished`).
- **Results.** Each item answers `applied` (with `notes`, `overrode`, `hasChanges`, and
  `itemClosed` with `itemDisposition: "applied"` exactly when this command dropped the
  item's created row), `already_live`, `held`, `not_found` or `failed`; item routes
  also answer `stale`, `whole_item` and `gone`. An edited item's content Apply never
  closes anything, even when it empties. `overrode` is the conflicts of the merge that
  actually committed. `hasChanges` is `has_effect` read in the transaction that writes
  the command's terminal result.
- **Idempotency.** Every outcome of a valid, authorized command is recorded under its
  `commandId`: a known id answers its stored outcome before anything resolves, and a
  different digest answers `409 command_conflict`. Refusals (`gone`, `whole_item`,
  `stale`) are recorded with a conflict-safe claim in their own small transaction
  (`DraftCommands.record`, via the service's `refuse`) before the response; a domain
  `gone` decided under the Discard kernel's locks restates the claim in the same
  transaction. A resend after `already_live` never re-merges, and a resend after a
  refusal never turns into an Apply. Per-item no-write results ride in the
  `draft_tree` payload's `command.decided` and join the terminal result at completion.
  Only malformed, unauthorized and conflicting requests stay unrecorded.
- **Invariant**: no path applies draft bytes to live or live bytes to a text branch,
  and a seeded text branch holds no item from a live client.

## Settlement mechanics

- **Sorted push locks**: `BranchCriticalSections` is the only owner of the
  branch `KeyedMutex`. It deduplicates and sorts branch IDs, produces an opaque
  lease, and is constructed once in `composition.ts`. The mutex does not live on
  `BranchStore`. Do not make the mutex reentrant (that conceals lock-order
  cycles) and do not split push/coordinator mutexes (that creates inversion).
  Callers acquire branch locks in branch-id order, then live coordinator locks
  in document-id order.
- **One push commit seam**: staging, replanning and the trail live in
  `branch-push.ts` and `branch-push-preparation.ts`; locked preparation computes one
  block diff from the live lock cut, and `branch-trail-projection.ts` turns it into the
  sole durable publication record without duplicating that diff into lineage.
  `branch-push-transition.ts` alone orders capture through fenced completion. The
  transition delivers a hint of the committed trail to connected bare-document rooms
  only after the completion fence reports applied/already-applied. Delivery is a
  session-local hint: it is not queued or replayed, and a vanished room cannot
  fail an otherwise durable push. A durable commit requires its trail bundle.
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
  Dispatch and reconciliation do not duplicate aggregate SQL.
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
  disclosure and navigation but cannot mutate the manuscript.
- **Durable trail signals**: receipt/part, journal disposition, publication,
  settlement and turn-lifecycle row triggers append to `change_trail_dirty_log`
  in the producer transaction. They never update owner rows or enroll commands
  in another lock protocol. One SQL resolver (`change_trail_owners`) follows
  immutable inverse targets; both capture and readiness use its semantic owners.
  A content publication (`push_lineage.apply_payload` set) is owned by the chats
  behind its branch's `active` and `rollback_pending` journal rows, since it pushes no
  journal rows. Writer inverses stay ownerless.
  After sorted aggregate advisory locks, reconciliation deletes exactly the
  snapshot-visible signals and reads readiness/terminality in one statement.
  Shell transitions and versioned delivery events commit with that deletion;
  failure restores all three. Sequence allocation is not commit order: never use
  a sequence watermark. Unfinished shells keep polling after consumption. Active
  drafts do not block, but rollback-pending journals and pending live settlements
  do, including inverse-only publications. Shared signals never create shells;
  active turns without shells retain their signals outside actionable paging.

- **Apply settles ahead refs per completion because drafts cannot move documents**
  (contract §9.4, L6). A draft only creates, edits, and deletes; every move is
  live and settles in the tree store's move transaction. So the only documents an
  Apply brings to an address are draft creates the draft tree step publishes, their
  SQL address is already final, and the tree step's `afterAdmission`
  (`adapters/drizzle-draft-tree-step.ts`) settles them once through
  `DocumentArrivals.settle` under Work → namespace → holder locks. Draft-held moves
  would break that: a document's address would depend on the view. Building them
  changes `context/adapters/document-address.ts` (current address and exact occupant
  become view-dependent), `context/adapters/document-link-scope.ts` (per-view
  URIs), `context/links/move-link-count.ts` (the note is counted at Apply), and
  the tree step here (moved documents become arrivals, and their old and new
  namespaces both lock).
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
  are parameters, while join-version advancement follows one SQL path. Push
  admission identity does not transfer AI content authorship to the admitting
  writer.
  Provenance admission is root-unit injective: one protected root unit may have
  only one visible target, so divergent restoration or replication blocks rather
  than granting deletion credit to either copy.
  Settlement writes the complete push trail in its existing aggregate version; only
  journal or staged-push authority joined after the durable commit publishes another
  trail version. If that admission's aggregate fold cancels a provisional row,
  settlement restores the push contribution from the replacement's durable
  owner/title context.
- **Settlement verification stack**: transition ordering, deletion rechecks,
  lease expiry and handoff, and fault windows run in
  `domain/branch-push-transition.test.ts` over real Yjs, in-memory ports and fake
  time; add new matrix cases there. The PostgreSQL killed-process oracle
  (`branch-push-settlement-oracle.db.test.ts`) keeps only what an in-memory port
  cannot prove: the cold lock cut with post-cut joins, stale-claim fencing
  against a live holder, and commit-fault durability inside the completion
  transaction. `branch-push-durable-projection.db.test.ts` owns SQL-dependent
  replay, aggregate row version, fold restoration, and journal attribution
  assertions; do not move them to fakes. Pure provenance and policy semantics
  belong to their focused owners rather than to a second PostgreSQL replay graph.
  The oracle is necessary but not sufficient: `lib/compose.runtime-settlement.db.test.ts` must
  also drive the real `createProductionAppPorts` + `composeAppServices` +
  Hocuspocus + worker-drain chain with production-shaped sync-step-2 full-state
  updates, and release probes must verify writer-visible trail flows.
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
  The invisible-write notice (`draft_write_invisible`) is one such participant.
- **Report-only agent commits**: direct writes always merge through Yjs. Neutral
  target-to-root lineage plus compact first-origin writer evidence drives best-effort
  live sweep detection in agent-edit's response committer; destructive-safety provenance
  remains a separate conservative lifecycle classifier. Checkpoint manifests carry
  safety attribution across repeated compaction and floor-null authority
  replacement. Under the same document-mutation lock as generation replacement,
  compaction reads, folds, and deletes only the current authority generation;
  retired-generation suffixes never enter restored authority. Compaction
  (`journal.compact`) is implemented but has no production caller. Durable trails
  retain the ordinary before/after record regardless of classification. Settlement
  itself runs no sweep and never blocks Apply on missing evidence.

## Recovery pass bounds

The process recovery scheduler invokes the change-trail worker as an independent
lane. Each pass considers at most 100 recoverable live settlements, reconciles
100 owner keys, and dispatches at most 100 outbox rows. Reconciliation pages only actionable owners/shells (including shared reopen
work while a turn is active), retaining one wraparound owner-key cursor and acquiring
the selected trail locks in sorted order; all updates are restricted to that
locked set. It keeps its own root transaction, not the runtime inbox owner.

The change-trail scheduler count is dispatched outbox rows, not reconciliation
transitions or settlement-recovery attempts. Other lanes report candidate counts.

## Settlement failure reporting

A failed batch retries with a backoff capped at 60 s; there is no dead letter.
Reports carry ids in correlation and codes from `DIAGNOSTIC_CODE_ENUMS`:

- `settlement.batch_failed` (warn) on every failed attempt except the 10th.
- `settlement.batch_stuck` (error) once, at attempt 10.
- `settlement.batch_blocked` (error, with `code`) on every transition to blocked.
- `settlement.failure_record_failed` (error) when the failure record cannot be written.

Only `DurableTrailSeedError` (a corrupt trail seed) blocks a batch at claim; any
other claim failure is recorded as an ordinary failed attempt.

The rebase reports through its own emitter (`collab.draft_rebase`):
`base.uninitialized`, `merge.failed`, `late_peer.edit_lost`, `late_peer.recovered`
and `late_peer.unrecovered`, one event per transition, never per inspection. A
batch fence on rebases is reported by the settlement owner, not by each fenced pull.
Writer admission reports `branch_writer.refused` with a `reason`.

## Publication ownership

A content member's trail is live before and after its merge, so it records exactly
the text the Apply changed. Owner sets come from the net live-to-merged changed
blocks through the same clock attribution index as review
(`draftOperationIdsByChangedBlock` over the branch's reviewable journal rows).
Cancelled writer delete/restore strokes therefore do not add a shared writer owner to
an AI-only publication. Certified restoration aliases are replayed from journal
metadata; physical writer update rows are not relabeled or removed. Apply's trail and
receipt use the originating AI turn, including on cold replay.
