# Controls

`/compact` is a transcript command in the durable inbox. Handoff Stop
and Retry act on handoff seeds, not inbox controls; see [handoff](handoff.md).

## Queue order

The inbox is one durable queue, but commands wait until the message queue is
empty. At a reply boundary, `next(pending, "boundary")` adopts every pending
non-command row, even those enqueued after a command. At run start, every
non-command row is adopted when any message is waiting; otherwise the oldest
command runs alone. A command never runs at a tool boundary. Stop only ends the
current turn. Release then applies the same selection rule.

Withdrawing a queued command removes it without changing message eligibility.
Messages that arrive while a command runs remain queued for the successor reply.

## Ownership and withdrawal

The start commit consumes the command: C's reservation commit acknowledges
`/compact`. A crash while a command waits leaves it queued; a crash after
`/compact` starts repairs C. A setup or start-commit error before C exists also
leaves the command queued for Withdraw or the periodic sweep. It cannot block a
waiting message because run-start selection always takes messages first. The
command is not replayed after C exists.

Withdrawal acknowledges a command that has not started and returns
`withdrawn`, including on replay. If a C already records its id,
withdrawal returns `already_started`; it does not stop that run. Enqueue and
withdrawal share the thread lock with command reservation.

A failed manual C consumes its command. Messages that arrived while it ran remain queued for a later reply.

For the shared selection and release wake contract, see [delivery](delivery.md).
