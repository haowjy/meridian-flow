# Controls

Writer commands in the durable inbox: `/compact` and the chat's write-mode
switch (`{ kind: "write_mode", mode }`). Handoff Stop and Retry act on handoff
seeds, not inbox controls; see [handoff](handoff.md).

Two terms keep one meaning here. An **execution** is one run of a chat, one
hold of its run lease from run start until it releases the run claim
([run identity](delivery.md#run-identity)); it can span several assistant
turns, automatic compaction and interrupt waits. A **request boundary** is the
point between two model requests inside an execution, where steers are adopted.
"Reply" means only one assistant turn or the writer-facing grouping.

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
| `S, M2` | yield: end the execution | apply S, then run M2 |
| `M1, S` | adopt M1 | run M1, then apply S |
| `M1, S, M2` | yield | apply S, then run M1 and M2 together |
| `S` (with or without notices) | adopt as today | nothing: S stays pending |
| `S, C` | adopt as today | apply S, then run C |
| `C, S, M2` | yield | apply S, then M2, then C |

A switch is pending until a run is about to start. With nothing else to run,
S stays queued, in an idle chat as well as during a reply, and a reply ending
with S pending and nothing waiting leaves it so. Materialization
(`materializePrefix`) is not a request boundary: it keeps putting every waiting
non-command row into the graph in seq order and never yields.

Withdrawing a queued command removes it without changing message eligibility.
Messages that arrive while a command runs remain queued for the successor execution.

## The yield

A yield is a steer split that releases the claim instead of reserving the
successor. The run checks `yieldsAtBoundary` before the next request's budget
and iteration checks, so an execution out of credits still yields, and
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
  the execution ends with no successor. Its receipt stays unacknowledged:
  the messages wait for the next run.

Either way the execution ends (`execution.ended`) with the waiting messages
undelivered; the next execution is reserved for them and delivers them
([run identity](delivery.md#run-identity)).

The release wake then applies S, and a new run adopts the waiting messages and
chains its reply after the switch turn. A writer message sent while a switch is
queued is stamped `send`, not `steer`. Admission decides the stamp under the
thread lock that fixes the message's inbox order, and again on a retried
attempt, so a switch another tab commits first is always seen.

## Applying a switch

`applyDueSwitches(threadId)` takes `RunClaim.withExclusiveThread`, so it is a
no-op while an execution holds the chat; an execution's mode can't change under it. The
switch is due when run-start selection (`next(pending, "run_start")`) returns `switch`,
that is, when a run is about to start: a writer message behind it, or a compaction. A Retry
always starts a run, so it applies a pending switch first (`retrying`), and chains the
retry after the switch turn. A release wake with nothing else to run never applies one.
The apply is one transaction under the thread lock: set `threads.ai_write_mode`,
append a complete `system` turn at the active leaf (`writeMode` = the new mode, metadata
`{ kind: "write_mode_switch", mode, controlMessageId }`) whose text block is
the model's `<system_update>` notice, acknowledge the control and publish the
pending inbox. No model call and no lease. `RunStarter.start` calls it before every
drain (enqueue wake, release wake, sweep); the run reports no work when selection returns
`switch`, and the wake's reread reaches `applyDueSwitches`. The sweep ignores a thread
whose only pending row is a switch.

A switch never wakes the chat and the route never applies one: the answer is
`pending` with no `turnId`, and `mode` is still the applied mode. The Work's
`default_ai_write_mode` follows the writer's latest choice instead of the apply: it is
set when the writer switches (a switch back and a Stop of the pending switch too), so a
chat created in between starts in the mode the writer just chose. A fork or handoff
starts in the mode the writer sees (`effectiveWriteMode`: the pending switch's, else the
applied one); a subagent keeps its parent's applied mode, which is the running reply's.

**Undo seam.** The switch turn owns no document edits: no change-trail rows,
no receipt, nothing undoable. Because the yield ends the execution, writes before
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
4. **Otherwise** the switch is queued, idle chat or not, and sets the Work's default.
5. `compact_requires_completed_reply` applies to `compact` only.

An acknowledged row with no switch turn answers replays with `pending` and
`turnId` both null, so a retried cancel never cancels a newer switch. The route
answers `{ id, pending, turnId }`: queued gives the waiting item (`turnId` null until
it applies, which an answer never sees), canceled or unchanged gives both null (201 when
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

A failed manual C consumes its command. Messages that arrived while it ran remain queued for a later execution.

For the shared selection and release wake contract, see [delivery](delivery.md).
