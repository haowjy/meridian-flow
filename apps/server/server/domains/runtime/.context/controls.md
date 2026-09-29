# Controls

`/compact` is a transcript command in the durable inbox. Handoff Stop
and Retry act on handoff seeds, not inbox controls; see [handoff](handoff.md).

## Queue order

Commands run only at the start of a run, one per run. At a reply boundary,
`next(pending, "boundary")` selects every non-control row. At run start,
`next(pending, "run_start")` selects the oldest command only when no message is
waiting; otherwise messages run first. Stop stamps pending commands, so the
oldest stamped command runs first together with the waiting messages. Esc means
"run what is queued now": every pending command is stamped, and each stamped
command runs ahead of later messages, one per run, until all stamped commands
have run. Messages adopted with a command stay pinned verbatim in compaction.

Reply boundaries and turn close never run commands. If a turn ends with only
commands waiting, the claim is released and the queue is re-read; the next run
starts the command. Messages arriving while it runs are answered after it.

## Ownership and withdrawal

The start commit consumes the command: C's reservation commit acknowledges
`/compact`. A crash while a command waits leaves it queued; a crash after
`/compact` starts repairs C. The command is not replayed.

Withdrawal acknowledges a command that has not started and returns
`withdrawn`, including on replay. If a C already records its id,
withdrawal returns `already_started`; it does not stop that run. Enqueue and
withdrawal share the thread lock with command reservation.

A failed manual C consumes its command, but it does not acknowledge the waiting
messages adopted with an Esc-stamped command. Those messages remain queued for a
later reply.

For the shared selection and release wake contract, see [delivery](delivery.md).
