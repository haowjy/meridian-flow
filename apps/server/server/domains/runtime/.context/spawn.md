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

A child `ask` finalizes an immutable `asked` execution report without ending
the child's lifetime. Background reports enqueue a structured question in the
parent; foreground calls return the same question directly. Request assembly
batch-loads the open questions present in that request. A `thread_message` to
that child carries the exact ask id from this evidence. The bound-message path
claims that ask before ordinary inbox delivery; losing the answer race turns
the unchanged text into an ordinary background message rather than binding it
to a newer question.

`ask({forward})` copies an open direct child's question. The parent's admitted
continuation relays its answer before the first model request and replaces the
provisional ask result with the child report, or with `late: true` when the
child question had already resolved (`spawn/forwarded-ask-relay.ts`). The relay
record lives on the forwarded ask and commits with the child's answer; the
parent's continuation row stays unacknowledged until the result is written, so a
crash replays the same relay call.

A continuation has one identity: the `ask_resolved {askId, delivery}` row the
answer transaction writes. `delivery` is `direct` only for a parent's foreground
answer (including the relay), and that row is enqueued without a wake so the
waiting call drives it with its own signal and tree budget; every other answer is
`background_notification`. The drain run that selects the row admits the
continuation: its report inherits the asked execution's invocation with the row's
delivery mode and records `continuationAskId`. A plain question's row is
acknowledged in that admission transaction; a forwarded one's after its relay.
A forwarded parent that crashed mid-relay reruns with a new execution, so
`findByContinuationAsk` returns the latest report for the ask.

Where a resolved ask's continuation stands is read in one place,
`spawn/ask-continuation.ts`: `outstanding` while its row is pending, `admitted`
once the row is gone and a continuation report exists, `cancelled` when the row is
gone with no report (a lineage cancellation dropped it before anything ran it).
The foreground caller drives the continuation if it is outstanding, then waits by
ask id, outside any lock, until it is admitted with a terminal report or cancelled,
which returns a cancelled result. It wakes on the child's committed thread events
(dropping a row journals the child's run state), and a replay waits the same way.
The report publisher uses the same reader: an asked invocation whose question
resolved with its continuation cancelled ends cancelled, like a withdrawn question.

Two delivery limits follow from one obligation per ask:

- A forwarded parent's rerun notifies its own parent twice. The crashed
  continuation is stale-settled `failed (orphaned)` and published, then the rerun
  publishes its own report, and a `background_notification` parent runs a turn for
  each. The card ends on the rerun's report.
- A `direct` continuation whose parent call died with the parent's own run (not a
  relay crash, which reruns) is run by the wake sweep with `deliveryMode = direct`.
  Its report updates the card but never reaches the parent model.

## Cards, reports, and activity

Cards retain the bound Agent identity, parent turn, child thread, delivery mode,
and nullable execution until admission binds the first committed reservation.
Terminal cards carry outcome and terminal time. Pre-admission failures have no
child/execution link. Publication preserves the original card block identity
and never carries report body. The same turn-position guard projects an asked
card to running at continuation admission and to its terminal outcome later.
Foreground calls return the exact terminal
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

A parked child exists only in the database, so lifetime follows thread lineage,
not live sessions. `TurnRunner`'s `cancelLineage(scope)` is the one operation, in
this order:

1. **Withdraw** (`spawn/lineage-cancellation.ts`): set the durable
   `cancel_requested` flag on every target's live lease (heartbeats and batch
   adoption in any process honour it), drop the targets' queued non-writer rows and
   their child notices to the owner, and, for Stop, a cancelled turn or Send now,
   drop the owner's continuation obligations (`ask_resolved` rows: a relay in
   flight, an answer not yet continued). An owner row stays only when an execution
   the command spared has adopted it; an adoption still in flight re-reads the rows
   under the same thread lock and finds nothing.
2. **Abort** the owner's execution the command cancelled and the targets' local
   sessions. Withdrawing first means no aborted run's cleanup wake finds the
   owner's continuation and replays its relay.
3. **Wait** for this process's targets, bounded at 5 s so a tool that ignores its
   abort can't hold Stop; then withdraw again (what the ending runs queued). The
   abort repeats while a target restarted on a notice; such an aborted wake is not
   logged as `wake.failed`.
4. **Settle**: cancel open asks, the cancelled turn's own question after its
   subtrees' (an open ask holds its thread's queue, so asks lift only once the
   queues are empty), then finalize each parked invocation whose continuation is
   cancelled through `report-publisher` (`settleCancelledAsk`: card,
   `agent.run_completed`, `spawn_status`).

Runs in other processes, or past the wait bound, stop at their next heartbeat
(`DEFAULT_LEASE_TTL_MS / 3`, about 10 s); a notice they publish after the last
withdrawal can still wake a parent. Stop decides the owner's execution from what
the writer saw: a continuation that started after the client's last view (an
answer followed at once by Stop) is spared, keeps its row and replies.

Ownership decides the scope:

| Trigger | Scope |
|---|---|
| Stop on a chat | the whole subtree, whichever turn spawned it ("stop everything") |
| Cancelling a turn, or Send now | only subtrees whose root that turn's execution spawned (`origin_turn_id`); a turn parked on its question is cancelled by withdrawing it |
| Deleting a thread or Work (`stopThreads`: chat trash, Work delete, the work tool, receipt reversal) | each deleted thread's run and whole subtree, one lineage per topmost thread |
| A child's terminal run | its whole subtree, before its claim is released |

`asked` is non-terminal for the last rule, so descendants keep running and their
notifications wait behind the question barrier. Foreground children always follow
their caller's abort signal.
