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
| `M1, S` | adopt M1 | run M1; S stays pending |
| `M1, S, M2` | yield | apply S, then run M1 and M2 together |
| `S` (with or without notices) | adopt as today | nothing: S stays pending |
| `S, C` | adopt as today | apply S, then run C |
| `C, S, M2` | yield | apply S, then M2, then C |

A switch is pending until a run is admitted. With nothing else to run, S stays
queued, in an idle chat as well as during a reply, and a reply ending with S
pending and nothing waiting leaves it so. Materialization
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

Either way the execution ends (its lease row is released) with the waiting
messages undelivered; the next execution is reserved for them and delivers them
([run identity](delivery.md#run-identity)).

The release wake starts a run, which applies S at its start, adopts the waiting
messages and chains its reply after the switch turn. A writer message sent while a switch is
queued is stamped `send`, not `steer`. Admission decides the stamp under the
thread lock that fixes the message's inbox order, and again on a retried
attempt, so a switch another tab commits first is always seen.

## Applying a switch

A switch applies at the admitted run start (`selectRunStart` in the delivery
adapter): after the start refusals, including the usage check, and under the
run's claim, so an execution's mode can't change under it. A refused start
leaves S pending. It is due when `next(pending, "run_start")` returns `switch`:
a message behind it, or a compaction. A Retry always starts a run, so it
applies a pending switch (`retry`). A lone switch never starts a run, so a
release wake with nothing else to run leaves it, and the sweep ignores a thread
whose only pending row is a switch. A switch queued while setup is in flight is
found by the selection's retry loop, and the start commit validates that
selection.

The apply commits in the thread-lock transaction that reserves the run: set
`threads.ai_write_mode`, append a complete `system` turn at the active leaf
(`writeMode` = the new mode, metadata `{ kind: "write_mode_switch", mode,
controlMessageId }`) whose text block is the model's `<system_update>` notice,
acknowledge the control and publish the run-state record (which carries the new
mode), then the reservation. All of it commits together or none of it does, so a
start that is aborted, cancelled or refused after it selected the switch leaves S
pending. No model call and no lease.

Preparation (references, images, skills, the compaction decision) reads storage,
and the history it builds must include the switch turn and the new mode. A start
that selects a due switch therefore skips the optimistic attempts and prepares in
the locked attempt, applying S first; there is no projected switch and no
compensating one. This holds the thread lock for that preparation, so a writer
admission on the chat waits for it (a start with no due switch prepares outside
the lock as before).

A switch never wakes the chat and the route never applies one. Switching back,
or Stop, cancels the queued switch with nothing recorded. The Work's
`default_ai_write_mode` follows the writer's latest choice, not the apply: it
is set when the writer switches, switches back or stops the pending switch (last
action wins), so a chat created in between starts in the mode the writer just
chose. A fork or handoff starts in the mode the writer sees
(`effectiveWriteMode`: the pending switch's, else the applied one); a subagent
keeps its parent's applied mode, which is the running reply's.

**Undo seam.** The switch turn owns no document edits: no change-trail rows,
no receipt, nothing undoable. Because the yield ends the execution, writes before
and after a switch always belong to different turns and responses, so no edit
or receipt spans a mode change. Keep both true.

Retry is runnable input at that boundary. Its compare-and-swap looks past
trailing switch turns to find the failed reply and chains the retry after them,
so a switch never takes Retry away; a newer message or another Retry moves the
leaf and refuses it, leaving the switch pending.

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

An acknowledged row with no switch turn answers replays with `turnId` null and
no item for it in the answer's `runState`, so a retried cancel never cancels a newer switch. The answer's fields are in the
[control API](../../../../../../docs/api/thread-controls.md#enqueue).

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
