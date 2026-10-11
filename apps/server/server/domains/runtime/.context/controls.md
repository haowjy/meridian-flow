# Controls

Writer commands in the durable inbox: `/compact` and the chat's write-mode
switch (`{ kind: "write_mode", mode }`). Handoff Stop and Retry act on handoff
seeds, not inbox controls; see [handoff](handoff.md).

Two terms keep one meaning here. A **reply** is one run of a chat, from run
start until it releases the run claim; it can span several assistant turns,
automatic compaction and interrupt waits. A **request boundary** is the point
between two model requests inside a reply, where steers are adopted.

## Queue order

The inbox is one durable queue, but commands wait until the message queue is
empty. At a request boundary, `next(pending, "boundary")` adopts every pending
non-command row, even those enqueued after a command. At run start, every
non-command row is adopted when any message is waiting; otherwise the oldest
command runs alone. A command never runs at a tool boundary. Stop only ends the
current turn. Release then applies the same selection rule.

The queued switch S is the one exception. A message behind S (any `message`
row with a higher seq) must be answered in S's mode, so:

| Pending (seq order) | At a request boundary | At run start |
| --- | --- | --- |
| `S, M2` | yield: end the reply | apply S, then run M2 |
| `M1, S` | adopt M1 | run M1, then apply S |
| `M1, S, M2` | yield | apply S, then run M1 and M2 together |
| `S` (with or without notices) | adopt as today | apply S |
| `C, S, M2` | yield | apply S, then M2, then C |

With nothing behind it, S runs as the oldest control. Materialization
(`materializePrefix`) is not a request boundary: it keeps putting every waiting
non-command row into the graph in seq order and never yields.

Withdrawing a queued command removes it without changing message eligibility.
Messages that arrive while a command runs remain queued for the successor reply.

## The yield

A yield is a steer split that releases the claim instead of reserving the
successor. The run checks `yieldsAtBoundary` before the next request's budget
and iteration checks, so a reply out of credits still yields, and
`splitAndContinue` and `close`'s `continueWith` check repeat the decision under
the thread lock for a switch that lands later. Cancellation wins: `adopt`
checks it under the lock first; the early yield rechecks the run's local signal
(a parent's cancel, shutdown) after its boundary read; and `close` rereads both
the durable flag and the local signal under the lock, turning a success close
into a cancel or the shutdown failure.

- **Assistant turn.** It completes `end_turn` through the ordinary success
  close. Nothing is adopted, no peeked notice is consumed and no successor is
  reserved. Tool writes committed before the boundary, so there is no second
  save.
- **Compaction placeholder** (automatic or manual). It completes through its
  own preparation and completion callbacks, so it keeps its real outcome, and
  the claim is released with no successor. Its receipt stays unacknowledged:
  the messages wait for the next run.

The release wake then applies S, and a new run adopts the waiting messages and
chains its reply after the switch turn. A writer message sent while a switch is
queued is stamped `send`, not `steer`. Admission decides the stamp under the
thread lock that fixes the message's inbox order, and again on a retried
attempt, so a switch another tab commits first is always seen.

## Applying a switch

`applyDueSwitches(threadId)` takes `RunClaim.withExclusiveThread`, so it is a
no-op while a reply holds the chat; a reply's mode can't change under it. Each
due switch is one transaction under the thread lock: set `threads.ai_write_mode`
and the Work's `default_ai_write_mode` (thread, then Work), append a complete
`system` turn at the active leaf (`writeMode` = the new mode, metadata
`{ kind: "write_mode_switch", mode, controlMessageId }`) whose text block is
the model's `<system_update>` notice, acknowledge the control and publish the
pending inbox. No model call and no lease.

It runs after a switch enqueue commits (the idle case), in `RunStarter.start`
before every drain (release wake, sweep), and indirectly when run-start
selection returns `switch`: the run reports no work, and the release wake's
reread reaches `applyDueSwitches`.

The control route applies an idle chat's switch itself before answering. A
short exclusive claim (idle materialization, a rebind) only delays it: the
route retries for about 2 s while no run lease holds the chat, and stops at
once when a reply holds it (the release wake applies it). A claim that outlasts
the retries turned them away, and a short claim that turned an attempt away
wakes its chat on release (`loop/contended-claim-wake.ts`, wrapped around the
run claim at composition), so the switch applies right after it releases. That
tracking is process-local: only a claim held by another server process leaves
the switch to the sweep. No wake runs beside the route's attempts, because a
wake applying the switch would race the answer. The answer reads the control's
switch turn and queue row together under the thread lock after the attempts,
so a reply's release applying the switch lands wholly before or after it: a
switch turn recording the control means applied, a waiting row means queued.

**Undo seam.** The switch turn owns no document edits: no change-trail rows,
no receipt, nothing undoable. Because the yield ends the reply, writes before
and after a switch always belong to different turns and responses, so no edit
or receipt spans a mode change. Keep both true.

Retry looks past trailing switch turns to find the failed reply and chains the
retry after them, so a switch never takes Retry away.

## Enqueue, cancel-out and replay

Enqueue runs under the thread lock, and every request writes its own row.

1. **Replay by id** answers the row's state. A different body (whole-body
   comparison) is 409 `control_id_conflict`.
2. **Switch back.** A switch to the other mode than the queued one acknowledges
   the queued row and writes the new row already acknowledged, in one
   transaction that journals only the final queue (`enqueueSettled`). Nothing
   shows in the chat, no snapshot ever holds both switches, and a chat has at
   most one queued switch.
3. **No change.** A switch to the queued mode, or to the chat's current mode
   with nothing queued, writes the row already acknowledged.
4. **Otherwise** the switch is queued and, if the chat is idle, applied at once.
5. `compact_requires_completed_reply` applies to `compact` only.

An acknowledged row with no switch turn answers replays with `pending` and
`turnId` both null, so a retried cancel never cancels a newer switch. The route
answers `{ id, pending, turnId }`: applied gives the switch turn's id, queued
gives the waiting item, canceled or unchanged gives both null (201 when
created, 200 on replay).

## Ownership and withdrawal

The start commit consumes `/compact`: C's reservation commit acknowledges it.
A crash while a command waits leaves it queued; a crash after `/compact`
starts repairs C. A start-commit error before C exists also leaves the command
queued for Withdraw or the periodic sweep. It cannot block a waiting message
because run-start selection takes messages first unless a switch is due. The
command is not replayed after C exists. A switch commits with its turn; a crash
before that leaves it queued.

Withdrawal acknowledges a command that has not started and returns
`withdrawn`, including on replay. If a turn already records its id (C or a
switch turn), withdrawal returns `already_started`; it does not stop that run.
Enqueue and withdrawal share the thread lock with command reservation.

A failed manual C consumes its command. Messages that arrived while it ran remain queued for a later reply.

For the shared selection and release wake contract, see [delivery](delivery.md).
