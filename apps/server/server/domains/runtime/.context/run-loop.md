# Run loop

A run holds one thread claim through model calls, tool execution, and assistant
turns. `orchestrator.ts` owns the skeleton; [delivery](delivery.md) decides what
enters it, [request assembly](request-assembly.md) builds model input, and
[compaction](compaction.md) shrinks history.

## Ownership boundaries

`RunTurnPort.prepare()` performs setup and returns a one-shot `execute()`; setup
commits before model execution, and the journal/hub is the event consumer, not
an orchestrator generator. `RunSession` owns the process-local abort signal,
current-turn registry, heartbeat, cancellation, and best-effort release.
`RunClaim` is the cross-process authority: short exclusive work and observable
heartbeating execution share one session claim. Only delivery binds the current
turn and receipt.

A new holder settles a crashed run's row (repair, then end and delete) before
inserting its own, so the crashed receipt is retired together with its turn.
Receipt mutations are guarded by thread, run, holder, and exact IDs; heartbeat
expiry alone never authorizes a paid commit. Cancellation matches any selector
bound to the live run under the lease row lock, so an old segment may stop its
current successor but an ended run cannot stop a new one.

## Persistence and accounting

Every mutation uses `persistAndAppendEvents`: read-model projection creates the
turn/block/model-response rows before journal append, satisfying the journal
foreign key, and both occur in one transaction. Tool dispatch persists typed
`tool_result` values and delegates policy to the per-turn gate. return-result
settlement remains spawn-owned.

**Failure records.** `projectAndAppendEvents` (`loop/persistence.ts`) is the one seam
every live durable event passes through inside its transaction, so it is also
where a failure is detected (`loop/failure-detection.ts`). A `turn.error`
becomes `failure.recorded` (the occurrence is the turn id, classified by
`classifyReplyFailure` from `@meridian/contracts/failures`), plus an immediate
`failure.ended { moved_on }` when a closing row already follows the turn (the
carried case), naming the first closing row after it on the active chain (`firstClosingRowAfter`),
not the latest: a reply that fails after the writer sent U then V ends `moved_on` by U. `turns.forgotten` says which content leaves the model's history and ends
nothing. A failure ends at the first boundary that follows it (a closing row, a Retry, or a
same-run continuation), and only there. `decideForgetting` owns that: its `ends` lists every
failure that ends at the boundary (the latest failed row, forgotten or kept, and the newest
failed handoff seed) with how it ends (`retried`, `forgotten`, `moved_on`). Older members of a
failed chain ended at the boundaries that followed them. The append primitive records exactly
that list (run start decides the same, and only the commit records). The recorder records what
it is given and keeps no memory of earlier ends. A failed handoff seed's Retry records `retried` in
`brief-service.ts`, because the Retry seed's `turn.created` names no seed. A usage
block records `failure.recorded` and its clear `failure.ended { resolved }`
from `setBlockedReason`, with occurrence `usage:${threadId}:${episode}`, where the
episode is the journal seq of the chat's last unblocked `run_state.changed`
record (no column holds it). `interrupts.ts` projects directly and calls the same
detector. The projector itself never logs.

Records go to the `recordFailure` a `LiveEventWriter` carries (required by
`PersistenceDeps`; `noFailureRecorder` is the explicit opt-out; the raw journal stays
append-only), which queues them on the
`FailureRecord` transaction participant (`shared/failure-records.ts`): own
state, forked and merged across savepoints, emitted through `recordFailure` over
`emitEvent` after the outermost commit. Within one Drizzle transaction a repeated
`(occurrenceId, phase)` emits once; across transactions uniqueness comes from the
transition decision, not from the participant. A rolled-back transition emits
nothing on Drizzle. The in-memory repositories do the same per `InMemoryTransactionOwner`: the
journal writer takes the owner of the repositories it serves (required; a fixture with no
transactions passes `noTransactionOwner`, and `createRuntimeHarness` reads the owner off the
repositories it is given), and `owner.afterCommit` runs a
record when that owner commits and drops it when that owner rolls back. A nested `run` on the
same owner joins the outer transaction (it is not a savepoint); another owner's transaction
neither emits nor discards it. Outside any transaction a record emits at once. The journal row is the durable
record; the log entry is its classified, best-effort view.

`POST /api/threads/:threadId/turns/:turnId/retry` is available only for the
latest failed assistant reply on an idle primary or subagent thread; a repeated
client ID is answered with the same execution from durable facts, and once
`prepare` returns, Retry hands the run to execution before any descriptive read
so no exit after preparation can strand a heartbeating claim.

`persistModelResponse` mints the response ID used by tool handlers. After all
tool results persist, response-scoped agent-edit writes commit; staged results
are replaced by settled receipts in the same transaction. A staged result left
by process failure becomes a typed rejection only when its canonical result
shape and staged phase are both present. Cancellation rolls the response buffer
back before finalizing the turn.

Summary calls use `TurnAccounting.computeAndDebit` and the shared tree budget;
handoff settlement is outside this loop. Summary calls do not consume model
iterations or the turn budget. The explicit gateway, repositories, retained
Agent reader, tool registry/executor, delivery, claim, credit ledger, child
coordinator, interrupts, EventSink, and background tracker are required ports;
no disabled behavior is represented by an omitted dependency.

## Queue, release, and shutdown

Run start and `wakeIfRunnable` share delivery's message-first selector. A
failed assistant acknowledges its adopted messages and is never restarted by a
release wake or periodic sweep. Explicit Retry starts a normal no-input run
whose history includes the failed turn; it does not restore inbox provenance.

One process-shared `DetachedWorkTracker` covers cleanup wakes, child completion,
handoff briefs, lease I/O, and post-commit work. Shutdown sets its flag before
aborting live work, settles paid rows, records `reason: shutdown`, acknowledges
receipts, releases claims, and suppresses new starts/wakes. The bounded runtime
drain and recovery-lane limits come from the process shutdown deadline. Nitro
dev's worker termination may leave repair to restart; production signals use
the same shutdown hook sequence.

## Invariants

- A turn permits at most 32 model/tool iterations.
- Cancellation is authorized only by the run signal or durable cancel request,
  checked before calls, after stream events, and around tool execution.
- Tools run in parallel unless registration marks them sequential; timeout and
  abort races belong to the executor.
- Response-write settlement is report-only: ordinary Yjs merge commits;
  destructive effects are echoed and trail evidence stays lifecycle-neutral.
- Production runners hold the cross-process claim through completion delivery;
  process loss therefore leaves work for [recovery](recovery.md).
