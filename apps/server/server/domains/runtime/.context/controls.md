# Controls and the barrier

Writer controls are queued commands that act on the conversation itself:
`/compact`, undo, and the handoff brief. They share the inbox with messages
but take no transcript position until a run boundary executes them.

## Position at execution

A control K (`intent: "control"`, a `ControlBody` of kind `compact`,
`compaction_undo`, or `handoff_brief`; the contracts package owns that list)
takes no transcript position at enqueue. This file covers the barrier and
`compact`; [undo](undo.md) and [handoff](handoff.md) cover the other two. A
`/compact`'s C is reserved at the leaf when a run boundary executes it,
mid-task included; writer sends keep their enqueue
position. So `hi1`, `/compact`, `hi2` sent while one reply streams compact
before either message is answered, and both are pinned. Never reserve a
control's placeholder at enqueue: a run can only reserve at the leaf, so a
message queued ahead of the control would be answered after it. Controls have
no run kind of their own; they execute through the boundaries a run already
has. Rationale and rejected shapes:
[Thread Controls Take Their Position When They Execute][kb-thread-controls].

## The barrier

`planControlBarrier` (`control-barrier.ts`) selects the raw inbox before Work
coalescing and ack-id calculation. A head control waits for unbound directed rows ahead unless a
chained row lies behind it; then every chained row and the inbox-only prefix
are adopted before C. Notices alone never delay K. Controls never enter
`drainInbox` or `planMessageTurns`. The first request after reservation uses its
already-prepared context, not another control boundary.

## Wakes

Writer enqueue keeps writer turns visible immediately. Its prefix materializer
uses the barrier but never reserves a control. Idle materialization holds a
claim, repairs orphaned primary assistants and pending placeholders first,
and then uses the same selection.
A normal assistant close defers an executable control to the post-release wake;
a tool boundary executes it inline. Both durable wake sweeps include controls.
Cleanup wakes only when the raw pending barrier can execute a control now,
with no bound/chained exemptions from the released run. A directed row ahead
of K follows the ordinary message restart rule; failed replies and failures
before reservation retry through the sweep, not a hot post-release loop.

## Executing a control

The compaction decision and its refusals are in
[compaction](compaction.md#decisions-and-refusals). If run-start preparation
itself fails while K executes, the run still reserves
K's manual C, with only `trigger` and `controlMessageId` in its metadata and no
plan, ends it `error` with the preparation failure's copy, and acknowledges K
with the batch. Code reading a manual C's metadata must not assume a plan; the
interrupted copy reads `trigger` directly for this reason.

A control's ending commit acknowledges its row, then reserves/binds the next
due control, reserves B for an outstanding message or ongoing task, or releases
the lease atomically. A control-only idle compaction creates no B. A failed
optional manual summary continues the ordinary request. Stop on a manual C
acknowledges controls only, leaving unanswered messages for the owner's
post-release wake; ordinary autocompaction Stop retains its old receipt
semantics. A crash leaves K pending for redelivery after orphan finalization.

## Enqueue, withdrawal, and absorption

`thread-controls.ts` owns writer enqueue and withdrawal, separately from the
message producer port. Client ids remain taken after execution or withdrawal.
The thread lock serializes withdrawal with reservation. A manual control bound
as `controlMessageId` becomes Stop, even after receipt expiry: withdrawal marks
the locked receipt cancelled so a stalled owner cannot resume the compaction.
Withdrawal also retires the control immediately, preventing replay if that
owner dies before cleanup. `stopping` still describes the bound turn.
Only row-owned handoff seeds ignore expired receipts and settle directly. An absorbed `satisfiesControlId` returns
`already_finished`: the automatic C still retires it and answers its messages.
`absorbPendingCompact` owns satisfaction selection for initial and mid-run
reservation. Control enqueue finds the latest matching turn by control id
(`TurnRepository.findByControlId`), not by loading the transcript. See
[HTTP contracts](../../../../../../docs/api/thread-controls.md).

## Adding a control kind

The contracts package's `ControlBody` owns the kind list, but several unions
repeat it: the inbox body check, the WebSocket pending schema, the enqueue
route, the pending-inbox projection, notices, the transcript contracts, and the
app's control copy, divider, and queued rows. Search for an existing kind
(`"compaction_undo"`) and give each site an explicit decision, including the
barrier rule above and the writer surface.

[kb-thread-controls]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/thread-controls.md
