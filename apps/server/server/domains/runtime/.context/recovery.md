# Recovery: orphan repair and process lanes

What happens to work a dead process left behind. This file is the one owner
of orphan repair; other docs link here. Rationale:
[Process Death Turn Recovery][kb-process-death].

## Pending placeholders

A pending placeholder is a turn with status `pending` and a role in
`PENDING_PLACEHOLDER_ROLES` from `@meridian/contracts/threads` (`compaction`
and the handoff seed's `system`); a pending assistant turn is not one. Test
with `isPendingPlaceholder` or the database's `pendingPlaceholderPredicate`
(beside its partial index), never a local role or status check.

## The one finalizer

`finalizeOrphanedTurns` (`loop/orphaned-placeholder.ts`) settles a thread's
dead primary assistant turns (`pending`, `streaming`, `waiting_interrupt`) and
its unowned pending placeholders. It runs under the thread lock with a held
session claim, from exactly three callers:

- `RunSession.prepare`, through `delivery.repairOrphanedTurns`, after it
  acquires the new run's claim and before setup plans a control barrier;
- idle materialization, under its exclusive claim, before planning;
- the startup and periodic orphan sweep (`spawn/orphan-report-repair.ts`),
  which pages indexed pending placeholders and unsettled primary turns so a
  quiet thread recovers without a new wake, and claims each thread first.

Delivery adoption (`adoptBatch`) never repairs. A live run keeps its claim, so
repair cannot enter its thread; an expired lease row alone is not proof of
death.

Every path finalizes through `finalizeExecution` (`loop/execution-finalizer.ts`).
A recovered C records `reason: interrupted`, `phase: recovery` through
`compactionFailureMetadata`; a recovered seed records the same pair through
`recordHandoffSeedOutcome`. Interrupted placeholder copy comes from
`threads/domain/turn-metadata.ts`. A recovered turn therefore parses with the
same codec as a live failure ([compaction](compaction.md#failure-landing),
[handoff](handoff.md)).

**A pending placeholder named by a pending control row is owned, not
orphaned.** `finalizeOrphanedTurns` reads the pending inbox once under the lock
and skips a seed S whose `handoff_brief` control names it in `seedTurnId`, so
a crashed brief redelivers into the same S. Put any new ownership rule in this
function, never in one caller.

`finalizeOrphanedPlaceholders` is the child-report walk's placeholder-only
helper and carries no ownership rule; a handoff destination is never a
subagent. Child assistant turns stay with that walk, which finalizes the report
on C and publishes after releasing the child's lock. A late writer message
stays unacknowledged and is redelivered rather than receiving a synthetic
failed reply.

Undo markers are system turns but never run-owned current turns: creation and
completion share one transaction, and terminal routing precedes brief dispatch.
Do not route a completed undo through the pending handoff-seed lifecycle.

Paid summary calls still held only in memory when a process dies are lost:
the finalizer cannot debit them, and a later delivery may pay again.

## Process lanes

`lib/recovery-scheduler.ts` owns only lane lifetimes. `app.ts` registers wake
scan, orphan repair, report publication, idle Work materialization, and
change-trail drain separately. Each starts at boot, rearms after completion,
and never overlaps itself. Lane failures are observed through EventSink and
cannot stall other lanes; completed passes report duration and the domain's
candidate/delivery count. Domains retain their own claims, transactions, and
paging cursors. Shutdown stops timers and awaits passes for up to five seconds
before draining the Yjs gateway and flushing observability. Still-running
lanes emit `shutdown.abandoned`; their promises retain observed rejection
handlers.

The wake lane (`sweepWakes`) is described in [delivery](delivery.md#locks-and-wakes).

[kb-process-death]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/process-death-turn-recovery.md
