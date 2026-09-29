# Controls

`/compact` is a transcript command in the durable inbox. Handoff Stop
and Retry act on handoff seeds, not inbox controls; see [handoff](handoff.md).

## Queue order

The inbox is one `seq`-ordered queue. At a reply boundary, `next(pending,
"boundary")` adopts the non-control prefix and stops before the first command. At
run start, an oldest command runs by itself; otherwise the same prefix is
adopted. A command never runs at a tool boundary. Stop only ends the current
turn. Release then re-reads the queue and runs its ordinary head.

Withdrawing a queued command exposes the rows behind it for the next boundary.
Messages that arrive while a command runs remain queued for the successor reply.

## Ownership and withdrawal

The start commit consumes the command: C's reservation commit acknowledges
`/compact`. A crash while a command waits leaves it queued; a crash after
`/compact` starts repairs C. The command is not replayed.

Withdrawal acknowledges a command that has not started and returns
`withdrawn`, including on replay. If a C already records its id,
withdrawal returns `already_started`; it does not stop that run. Enqueue and
withdrawal share the thread lock with command reservation.

A failed manual C consumes its command. Messages behind it remain queued for a later reply.

For the shared selection and release wake contract, see [delivery](delivery.md).
