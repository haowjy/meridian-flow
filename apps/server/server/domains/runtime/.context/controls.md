# Controls and the barrier

Writer controls are queued commands that act on the conversation itself:
`/compact` and compaction undo. Handoff brief Stop and Retry are operations on
the durable handoff seed, not inbox controls; see [handoff](handoff.md).

## Position at execution

A control K (`intent: "control"`, a `ControlBody` of kind `compact` or
`compaction_undo`) takes no transcript position at enqueue. `/compact`'s C is
reserved at the leaf when a run boundary executes it; writer sends keep their
enqueue position. The control barrier selects the raw inbox before Work
coalescing and acknowledgement. A head control waits for unbound directed
messages ahead unless a chained row lies behind it; then the chained rows and
inbox-only prefix are adopted before K. Notices alone never delay K. Controls
never enter ordinary message planning.

Control-only runs use the ordinary boundary and run lifecycle; there is no
row-owned placeholder exception or handoff branch. A normal assistant close
defers an executable control to the post-release wake, while a tool boundary
executes it inline. Inbox sweeps remain the durable wake path.

## Withdrawal and recovery

Withdrawal acknowledges an unbound row. If a live run already bound it,
withdrawal requests Stop for that run, even when the lease receipt is overdue.
The transaction retires the control receipt so a crashed owner cannot replay a
withdrawn request. Compaction undo is completed atomically and never has a
pending phase. Pending compaction placeholders are run-owned and are recovered
by [orphan repair](recovery.md); pending handoff seeds have their own claimed
recovery lane.
