# Spawn and child runs

This context covers nested-agent creation, `thread_message`, invocation cards,
activity, and reports. A `spawn.from` child receives a frozen reference, not
history; see [history tools](history-tools.md).

## Coordinator and configuration

`ChildRunCoordinator` authorizes a request, resolves the invocation, creates or
addresses the child thread, binds its Agent/configuration, and persists the
parent card. The driver feeds the child through the shared run session; it owns
no lease or terminal-report policy. `execution-finalizer.ts` owns the terminal
transaction, and `report-publisher.ts` replaces the card in a parent-first
publication transaction with body-free completion metadata and background
notice text.

Invocation patches are presence-sensitive and schema-validated before child
creation. Omitted fields inherit; model/effort replace; permission only lowers;
disallowed tools add and never lift a parent denial. Child tools remain a
subset of the parent. Named targets and skills resolve from the caller's
retained binding/dependency graph. The effective configuration and raw overlay
persist on the child binding; the Agent definition is not mutated. An additive
`append_system_prompt` never replaces the Agent body.

## `thread_message`

Background delivery resolves the project/user ref and may address any live chat
owned by that user in the project. It enqueues one agent-provenance message,
including the sender chat's title and handle, through `RuntimeDelivery`; it does
not drive the target. Foreground delivery
requires the target to be in the caller's subtree and returns its terminal
report, preventing waits on ancestors or unrelated chats. It loads the target's
frozen binding without re-resolving configuration, so a message cannot escalate
model, tools, prompt, or overlay. Bad, busy, or binding-less targets return typed
model-correctable failures.

A parent re-task carries notification correlation and publishes the same
completion notice as a background spawn; other background messages promise no
completion. The target's run owns wake and report admission.

A subagent has no `ask_user`. It does its task with reasonable calls and says in
its report what it assumed, or stops and reports what is missing. The parent
carries on from that report like any other: it does the work itself, sends the
child what it needs with a new `thread_message`, or asks the writer with its own
`ask_user`. No path binds a message to a question or relays an answer, so a
child's run starts only from an ordinary wake, which the fence below governs.

## Cards, reports, and activity

Cards retain the bound Agent identity, parent turn, child thread, delivery mode,
and nullable execution until admission binds the first committed reservation.
Terminal cards carry outcome and terminal time. Pre-admission failures have no
child/execution link. Publication preserves the original card block identity
and never carries report body. Foreground calls return the exact terminal
report; background spawn returns after admission; `thread_report` reads the
latest durable report.

A child report is admitted once and finalized with its terminal turn. Its
selector is the first admitted reservation; `terminalTurnId` identifies the
final turn. Internal execution UUIDs remain host-only. Reports are read through
the typed history/report path, not reconstructed from cards.

`return_result` captures candidate content only with its successful ordinary
`tool_result` in one transaction; capture alone never makes the child succeed.

Create and terminal/wake paths append neutral `subagent.activity` facts to the
direct parent's journal. Create is strict; terminal and wake activity is
best-effort and cannot gate the run. Partial tool activity records only the
small live-label fields needed by the client.

## Child identity and lifecycle

Named targets resolve within the parent's roster and refuse
`model-invocable: false`. An omitted/empty target creates an agent-less child
with no definition revision and the host generic identity, copying the caller's
resolved configuration. Named children use their retained revision. Permission
and tool denials remain monotone through nested generic children.

Maximum spawn depth is operator-configured at tree creation. Child creation,
Agent binding, and Work membership are one transaction. A child starts with an
unfrozen prompt; ordinary preparation adds its persona and report instruction.
Terminal persistence precedes helper/Work cleanup.

## Lineage cancellation

A background child lives on after the call that started it, so lifetime follows
thread lineage, not live sessions. Lineage cancellation is one durable command
(`spawn/lineage-cancellation.ts`), run inside the trigger's own transaction:

1. **The owner's lock.** Under it the trigger makes its own decision: Stop's rule,
   the turn's lease flag, Send now's rule.
2. **Each target's lock, parents first.** Under each target's lock its subtree is
   listed again, so a child whose spawn committed before that lock is a target
   too.
3. **One claim.** One statement cancels the targets' live asks and owed
   continuations, and the owner's live asks (a cancelled turn's own question
   only) and owed continuations (`continuationOwedSql`: `pending`, or NULL on an
   answered/expired ask an older server resolved).
4. **Per locked thread:** drop a target's queued non-writer rows, a stopped
   owner's queued `agent` and `child` messages, the report notices from targets
   and the hints for claimed asks. Write each claimed ask's cancelled tool result
   or `ask.updated`. Then set `cancel_requested` on the targets' live leases,
   stamp the **wake fence** (`threads.wake_fence_at`) on the fenced set, mark the
   targets' unpublished reports `notice_withdrawn`, and set `spawn_status =
   'cancelled'` on every target spawn still `running` (`cancelRunningSpawns`, the
   only writer of that value; a refused spawn writes nothing).

The **fenced set** is the targets, plus the owner when the writer stopped its
reply or deleted the chat. It is the one concept for "loses queued machine messages and
refuses new machine wakes"; a cancelled turn or a finished run leaves the owner
free to be woken. Work notices stay: they never start a run.

**The wake fence.** A stopped thread accepts no machine wake from an execution
admitted before its cancellation. A machine message names its sending execution
(`MessageDraft.sender`: a background `thread_message`, a child's admission by
spawn or foreground `thread_message`), and the delivery enqueue asks
`RunClaim.wakeRefusal` under the receiver's thread lock before writing the row. It
is refused when the sending execution no longer holds its lease or was flagged
(`sender_stopped`: a dying run sends nothing), or when the receiver's fence is
later than the sender lease's `acquired_at` (`receiver_stopped`). The sender gets a
`thread_stopped` tool result. Both times come from the database's
`clock_timestamp()`, so admission and fence compare on one clock. A spawn also
checks its sender under the parent's row lock, which the cancellation holds until
commit, so it either commits first and the cancellation finds the child, or sees
its sender stopped. Writer actions never ask, and an execution admitted after the
fence wakes the thread normally.

`notice_withdrawn` stays a separate column: it fences a *target's* report from its
parent, while the owner's own report must still reach its parent after Stop, and a
report is published (and republished by the sweep) after its execution's lease is
gone.

After commit the run session aborts its own sessions of the cancelled execution
and the targets; that only makes them stop sooner. Runs in other processes stop at
their next heartbeat (`DEFAULT_LEASE_TTL_MS / 3`, about 10 s). Whatever a dying run
writes meanwhile wakes nothing: its sends are refused by the fence, its queued
messages and hints are gone, and its report's publication projects the card but
enqueues no parent notice. Stop decides the owner's execution from what the writer
saw, and an execution that continues the writer's answer counts as one the writer
asked for, so Stop cancels it; a continuation of a machine wake that started after
the client's last view is spared and replies. The owner's claim takes its open
asks and owed continuations, but a pending ask (one a run is still asking) only
when it belongs to the execution the decision cancelled: a spared execution keeps
its question, and a cancelled run whose session is in another process cancels its
own pending ask when it closes.

**Lock order.** A thread lock takes its thread's held ask rows (live asks and owed
continuations) before its advisory lock (`shared/thread-work-lock.ts`,
`lockThreadAsks`), so no ask transition under a thread lock waits on an ask row.
Lineage cancellation is the only transaction that takes more than one thread's lock
(`asMultiThreadLocker`); outside production the Postgres thread lock throws on a
second thread's lock anywhere else. What is enforced, not assumed: after a
transaction's first thread lock, `lockThreadAsks` and the claim use `FOR UPDATE SKIP
LOCKED`, so an ask row another transaction holds is skipped, never waited on. Its
holder waits on a thread lock this command holds: it is a question asked during the
command, or a transaction that locked its thread's asks and waits for that thread's
advisory lock. After commit that holder sees the cancellation: a flagged run cancels
its own live ask when it closes, and a writer's answer that took the row first wins,
as any writer action does, unless the command deleted the chat: then the answer's
claim cancels the ask as the command would have. Nothing retries `40P01`.

Work delete and a Work receipt reversal's delete run the command on the Work's tree
before `lockWorkThreadTree` takes the tree's rows. Work lockers take
the tree parents first, by `(spawn_depth, id)` (`parentsFirst` in
`shared/thread-work-lock.ts`); lineage cancellation orders its owners, then locks each owner's
subtree the same way (`listSubtreeIds` orders by depth, then id); in id order a child with a smaller id
than its parent deadlocked a Stop against a restore or purge of the same tree.
`stopThreads` takes its threads already parents first and keeps that order (`lockWorkThreadTree`
sorts a Work's tree with `parentsFirst`; a trash passes one id). A Work's roots need not have
depth 0, since a subagent whose parent was rebound elsewhere stays a root of the old Work.

Ownership decides the scope:

| Trigger | Scope |
|---|---|
| Stop on a chat (`thread` reach) | the owner's reply only: its live execution, its open asks and owed continuations, and the owner's own fence. No descendant is cancelled, claimed, fenced or has its queue or `spawn_status` touched: Stop is the button that means "this reply", and a child has its own Stop. A surviving child's later report wakes the owner, since the fence only refuses senders admitted before the Stop |
| Cancelling a turn | only subtrees whose root that turn's execution spawned (`origin_turn_id`); a turn parked on its question is cancelled by withdrawing it. An explicit cancellation of that work, so it reaches what the turn started |
| Send now (`turn` reach, no `subtree`) | the reply's execution and its own question; the reply's children keep running, and the owner is not fenced, so queued reports reach the next turn |
| Deleting a thread or Work (`stopThreads`: chat trash, Work delete, the work tool, receipt reversal) | each deleted thread's run, its open asks and owed continuations, and its whole subtree, one lineage per topmost thread. Trash, Work delete and receipt reversal run it in their own transaction |
| A child's terminal run | its whole subtree, before its claim is released |

Foreground children always follow their caller's abort signal.
