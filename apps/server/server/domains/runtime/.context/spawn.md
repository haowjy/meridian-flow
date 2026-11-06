# Spawn and child runs

Child conversations, `thread_message`, reports and cards are decided in
[spawned conversations][kb-spawn] and [child reports][kb-reports]; what Stop leaves
running is [Stop ends the reply][kb-stop]. This page holds how cancellation locks,
claims asks and refuses wakes.

Create and terminal/wake paths append neutral `subagent.activity` facts to the
direct parent's journal. Create is strict; terminal and wake activity is best-effort
and can't gate the run.

## Lineage cancellation

A background child lives on after the call that started it, so lifetime follows
thread lineage, not live sessions. Lineage cancellation is one durable command
(`spawn/lineage-cancellation.ts`), run inside the trigger's own transaction:

1. **The owner's lock.** Under it the trigger makes its own decision: Stop's rule,
   the turn's lease flag, Send now's rule.
2. **Each target's lock, parents first.** Under each target's lock its subtree is
   listed again, so a child whose spawn committed before that lock is a target too.
3. **One claim.** One statement cancels the targets' live asks and owed
   continuations, and the owner's live asks (a cancelled turn's own question only)
   and owed continuations (`continuationOwedSql`).
4. **Per locked thread:** drop a target's queued non-writer rows, a fenced owner's
   queued `agent` messages (a deleted owner's `child` reports too), the report
   notices from targets and the hints for claimed asks. Write each claimed ask's
   cancelled tool result or `ask.updated`. Then set `cancel_requested` on the
   targets' live leases, stamp the **wake fence** (`threads.wake_fence_at`) on the
   fenced set, mark the targets' unpublished reports `notice_withdrawn`, and set
   `spawn_status = 'cancelled'` on every target spawn still `running`.

A thread's own `spawn_status` is settled by the execution finalizer when its run
ends, and only for a spawn-origin run; a re-task run never writes it. So
`spawn_status` is the spawn run's outcome, not the child's current state. Read
liveness from the lease and a later run's outcome from its turns and report.

The **fenced set** is the targets, plus the owner when the writer stopped a
subagent's reply (the decision's `fenceOwner`; Send now never sets it) or deleted the
chat. A stopped primary chat is not fenced: all that is queued for it comes from
below or the system, and a child's report still has to wake it. Work notices stay;
they never start a run.

**The wake fence.** A stopped thread accepts no machine wake from an execution
admitted before its cancellation. A machine message names its sending execution
(`MessageDraft.sender`), and the delivery enqueue asks `RunClaim.wakeRefusal` under
the receiver's thread lock before writing the row. It is refused when the sending
execution no longer holds its lease or was flagged (`sender_stopped`), or when the
receiver's fence is later than the sender lease's `acquired_at`
(`receiver_stopped`). The refused sender's tool gets a `thread_stopped` result. Both
times come from the database's `clock_timestamp()`, so admission and fence compare on
one clock. A spawn also checks its sender under the parent's row lock, which the
cancellation holds until commit, so it either commits first and the cancellation
finds the child, or sees its sender stopped. A child report carries no sender, so it
still lands on a fenced thread.

`notice_withdrawn` stays a separate column: it fences a *target's* report from its
parent, while the owner's own report still has to reach its parent after Stop, and a
report is published (and republished by the sweep) after its execution's lease is
gone.

After commit the run session aborts its own sessions of the cancelled execution and
the targets; that only makes them stop sooner. Runs in other processes stop at their
next heartbeat. Whatever a dying run writes meanwhile wakes nothing: its sends are
refused by the fence, its queued messages and hints are gone, and its report's
publication projects the card but enqueues no parent notice.

Stop counts an execution that continues the writer's answer as one the writer asked
for, so it cancels it; a continuation of a machine wake that started after the
client's last view is spared and replies. The owner's claim takes a pending ask (one
a run is still asking) only when it belongs to the execution the decision cancelled:
a spared execution keeps its question, and a cancelled run whose session is in
another process cancels its own pending ask when it closes.

**Lock order.** A thread lock takes its thread's held ask rows (live asks and owed
continuations) before its advisory lock (`shared/thread-work-lock.ts`,
`lockThreadAsks`), so no ask transition under a thread lock waits on an ask row.
Lineage cancellation is the only transaction that takes more than one thread's lock
(`asMultiThreadLocker`); outside production the Postgres thread lock throws on a
second thread's lock anywhere else. After a transaction's first thread lock,
`lockThreadAsks` and the claim use `FOR UPDATE SKIP LOCKED`, so an ask row another
transaction holds is skipped, never waited on: its holder may be waiting on a thread
lock this command holds. After commit that holder sees the cancellation. A flagged
run cancels its own live ask when it closes, and a writer's answer that took the row
first wins, unless the command deleted the chat: then the answer's claim cancels the
ask as the command would have. Nothing retries `40P01`.

Work delete and a Work receipt reversal's delete run the command on the Work's tree
before `lockWorkThreadTree` takes the tree's rows. Work lockers take the tree parents
first, by `(spawn_depth, id)` (`parentsFirst`); lineage cancellation orders its
owners, then locks each owner's subtree the same way. Plain id order deadlocks a Stop
against a restore or purge of the same tree when a child's id sorts before its
parent's. `stopThreads` keeps the parents-first order it is given. A Work's roots need
not have depth 0: a subagent whose parent was rebound elsewhere stays a root of the
old Work.

Ownership decides the scope:

| Trigger | Scope |
|---|---|
| Stop or Send now (`thread` reach) | The owner's reply only: its live execution, open asks and owed continuations. A foreground child follows the reply's abort signal. A stopped subagent still in its spawn run ends there, so its children end with it. |
| Cancelling a turn | Only subtrees whose root that turn's execution spawned (`origin_turn_id`). A turn parked on its question is cancelled by withdrawing it. |
| Deleting or archiving a thread or Work (`stopThreads`: trash, archive, Work delete, the work tool, receipt reversal) | Each thread's run, open asks and owed continuations, and its whole subtree, one lineage per topmost thread. |
| A child's terminal run | Its whole subtree, before its claim is released. |

[kb-spawn]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/conversations/spawn-child-conversation.md
[kb-reports]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/conversations/child-execution-reports.md
[kb-stop]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/stop-ends-the-reply.md
