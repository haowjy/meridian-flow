# Controls

Commands in the durable inbox: the writer's `/compact` and write-mode switch, and
the model's write-mode switch. Handoff Stop and Retry act on handoff seeds; see
[handoff](handoff.md). Policy is in [transcript commands][kb-commands] and
[chat write mode][kb-write-mode]; route answers are in the
[control API](../../../../../../docs/api/thread-controls.md).

An **execution** is one hold of a chat's run lease; it can span several assistant
turns and automatic compaction. A **request boundary** is the point between two
model requests inside an execution, where steers are adopted.

## Queue order

`next(pending, at)` is the one selector. At a request boundary it adopts every
pending non-command row, even one enqueued after a command. At run start, every
non-command row is adopted when any message is waiting; otherwise the oldest
command runs alone. A command never runs at a tool boundary.

The queued switch S is the one exception. A message behind S (any `message` row
with a higher seq) has to be answered in S's mode, so:

| Pending (seq order) | At a request boundary | At run start |
| --- | --- | --- |
| `S, M2` | yield: end the execution | apply S, then run M2 |
| `M1, S` | adopt M1 | run M1; S stays pending |
| `M1, S, M2` | yield | apply S, then run M1 and M2 together |
| `S` (with or without notices) | adopt non-command rows | nothing: S stays pending |
| `S, C` | adopt non-command rows | apply S, then run C |
| `C, S, M2` | yield | apply S, then M2, then C |

A switch stays pending until a run is admitted, in an idle chat as well as during
a reply. Prefix materialization (`prefixRows`) is not a request boundary: it never
yields, and it stops at the queued switch so no row crosses the mode that governs
it.

## The yield

A yield ends the execution at a request boundary and releases the claim instead of
reserving a successor. The run checks `yieldsAtBoundary` before the next request's
budget and iteration checks, so an execution out of credits still yields; `adopt`
and `close` repeat the decision under the thread lock for a switch that lands
later. Cancellation wins: `adopt` checks it under the lock first, the early yield
rechecks the run's local signal (a parent's cancel, shutdown) after its boundary
read, and `close` rereads both the durable flag and the local signal under the
lock, turning a success close into a cancel or the shutdown failure.

- **Assistant turn.** It completes `end_turn` through the ordinary success close.
  Nothing is adopted and no peeked notice is consumed. Tool writes committed before
  the boundary, so there is no second save.
- **Compaction placeholder.** It completes through its own preparation and
  completion callbacks, so it keeps its real outcome. Its receipt stays
  unacknowledged: the messages wait for the next run.

The release wake starts a run, which applies S at its start, adopts the waiting
messages and chains its reply after the switch turn.

## Applying a switch

A switch applies at the admitted run start (`selectRunStart`), after the start
refusals and under the run's claim, so an execution's mode can't change under it. A
Retry always starts a run, so it applies a pending switch. A lone switch never
starts a run: a release wake leaves it, and the sweep ignores a thread whose only
pending row is a switch.

The apply commits in the thread-lock transaction that reserves the run: the mode,
the `system` switch turn at the active leaf, the control's acknowledgement and the
run-state record, then the reservation. A start aborted, cancelled or refused after
selecting the switch therefore leaves S pending. Preparation has to see the switch
turn and the new mode, so a start with a due switch skips the optimistic attempts
and prepares under the lock; [FUTURE](FUTURE) has the cost and the rejected
alternative.

The Work's `default_ai_write_mode` follows the writer's latest choice, not the
apply: it is set when the writer switches, switches back or withdraws the pending
switch. A model-queued switch doesn't change it, including one the writer allowed
from a permission request, whose ask receipt records the Allow. A fork or handoff
starts in the mode the writer sees (`effectiveWriteMode`: the pending switch's,
else the applied one); a subagent keeps its parent's applied mode, which is the
running reply's.

**Undo seam.** The switch turn owns no document edits: no change-trail rows, no
receipt, nothing undoable. Because the yield ends the execution, writes before and
after a switch always belong to different turns and responses, so no edit or receipt
spans a mode change. Keep both true.

## Cancel-out

A switch back acknowledges the queued row and writes the new row already
acknowledged, in one transaction that journals only the final queue
(`enqueueSettled`), so no snapshot ever holds both switches and a chat has at most
one queued switch. A same-mode request also writes its row already acknowledged.
Such a row answers replays with `turnId` null and no item in `runState`, so a
retried cancel never cancels a newer switch.

[kb-commands]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/transcript-commands.md
[kb-write-mode]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/work/write-mode/chat-write-mode.md
