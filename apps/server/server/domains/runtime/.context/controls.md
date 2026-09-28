# Controls

`/compact` and Undo are transcript commands in the durable inbox. Handoff Stop
and Retry act on handoff seeds, not inbox controls; see [handoff](handoff.md).

## Queue order

Commands run only as the first step of a run, one per run. At a reply boundary,
`next(pending, "boundary")` selects non-control work only. At run start,
`next(pending, "run_start")` selects the oldest command only when no message is
waiting; otherwise messages run first. Stop stamps pending commands, so the
oldest stamped command runs first together with the waiting messages. Those
messages are pinned verbatim in compaction and answered after it.

Tool boundaries and turn close never run commands. If a turn ends with only
commands waiting, the claim is released and the queue is re-read; the next run
starts the command. Messages arriving while it runs are answered after it.

## Ownership and withdrawal

The start commit consumes the command: C's reservation commit acknowledges
`/compact`, and Undo is acknowledged in its atomic commit. A crash while a
command waits leaves it queued; a crash after `/compact` starts repairs C, and
a committed U is already complete. Neither command is replayed.

Withdrawal acknowledges a command that has not started and returns
`withdrawn`, including on replay. If a C or U already records its id,
withdrawal returns `already_started`; it does not stop that run. Enqueue and
withdrawal share the thread lock with command reservation.

For the shared selection and release wake contract, see [delivery](delivery.md).
