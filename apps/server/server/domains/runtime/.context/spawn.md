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

A child's `ask_user` call finalizes an immutable `asked` execution report without ending
the child's lifetime. Background reports enqueue a structured question in the
parent; foreground calls return the same question directly. Request assembly
batch-loads the open questions present in that request. A `thread_message` to
that child carries the exact ask id from this evidence. The bound-message path
claims that ask before ordinary inbox delivery; losing the answer race turns
the unchanged text into an ordinary background message rather than binding it
to a newer question.

`ask_user({forward})` copies an open direct child's question. The parent's admitted
continuation relays its answer before the first model request and replaces the
provisional ask result with the child report, or with `late: true` when the
child question had already resolved (`spawn/forwarded-ask-relay.ts`). The relay
record lives on the forwarded ask and commits with the child's answer; the
parent's continuation row stays unacknowledged until the result is written, so a
crash replays the same relay call.

A continuation's state lives on its ask, `asks.continuation`, beside
`continuation_turn_id` (the turn last admitted to continue it). Each event moves it
with one conditional update on the ask row, where answers already race:

| Event | `continuation` |
|---|---|
| Ask live (pending or open) | null |
| Answer or expiry | `pending`; the same commit writes the `ask_resolved {askId, delivery}` row, the wake hint |
| Admission (in the run's reservation commit) | a plain question `done`; a forwarded ask `admitted` until its relay ends; a crashed relay is admitted again |
| Relay finished (`forwarded-ask-relay.ts`) | `done`, with the rewritten tool result and the hint's acknowledgement, only for the admitted turn |
| Lineage cancellation, or the ask withdrawn | `cancelled` |

`delivery` is `direct` only for a parent's foreground answer (including the
relay), and that row is enqueued without a wake so the waiting call drives it with
its own signal and tree budget; every other answer is `background_notification`.
The continuation's report inherits the asked execution's invocation with the row's
delivery mode (`spawn/run-admission.ts`, which also picks a re-task's and a thread
run's correlation). A plain question's hint is acknowledged in its admission commit; a
forwarded one's when the relay ends.

Every reader reads the column. The foreground caller drives a `pending` or
`admitted` continuation, then waits by ask id, outside any lock, until it is `done`
with a terminal report at `continuation_turn_id`, or `cancelled`, which returns a
cancelled result. It wakes on the child's committed thread events (a cancellation
journals an `ask.updated`). The publisher, `thread_report` and `thread_history`
show an asked report whose question's continuation is `cancelled` as cancelled
(`saved-report-outcome.ts`, `reportOutcome`).

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
not live sessions. Lineage cancellation is one durable command
(`spawn/lineage-cancellation.ts`), run inside the trigger's own transaction:

1. **Ask rows first.** Lock the rows every lineage thread holds (live asks and
   owed continuations), in id order.
2. **Thread locks, parents first.** The owner's parent (a parked owner's card is
   there), then the owner. Under the owner's lock the trigger makes its own
   decision: Stop's rule, the turn's lease flag, Send now's rule.
3. **One claim.** One statement cancels the reached threads' live asks and owed
   continuations, and the owner's live asks (a cancelled turn's own question only)
   and owed continuations, except one admitted by an execution the decision spared.
4. **Per thread, parents first:** drop the targets' queued non-writer rows, the
   owner's child notices from them and the owner's hints for the claimed asks; write
   each claimed ask's cancelled tool result or `ask.updated`. Then set
   `cancel_requested` on the targets' live leases, mark their unpublished reports
   `notice_withdrawn`, and settle each parked invocation whose ask was claimed
   (`settleCancelledAsk`: card, `agent.run_completed`, `spawn_status`).

After commit the run session aborts its own sessions of the cancelled execution
and the targets; that only makes them stop sooner. Runs in other processes stop at
their next heartbeat (`DEFAULT_LEASE_TTL_MS / 3`, about 10 s). Whatever a dying run
writes meanwhile wakes nothing: its hint and notices are gone, its continuation is
`cancelled` so a re-drain admits nothing, and its report's publication projects the
card but enqueues no parent notice (`notice_withdrawn`). Stop decides the owner's
execution from what the writer saw: a continuation that started after the client's
last view (an answer followed at once by Stop) is spared and replies.

Lock order is ask rows, then thread locks parents first, then thread rows and
leases. The thread lock itself locks its thread's held ask rows before its
advisory lock (`shared/thread-work-lock.ts`, `lockThreadAsks`), so admission, the
relay's `done` and the finalizer's open-or-cancel of its own ask never take an ask
row under a thread lock. An answer that relays locks both ask rows, in id order,
before its claim. Work delete runs the command on the Work's tree before
`lockWorkThreadTree` takes the tree's rows.

Ownership decides the scope:

| Trigger | Scope |
|---|---|
| Stop on a chat | the whole subtree, whichever turn spawned it ("stop everything") |
| Cancelling a turn, or Send now | only subtrees whose root that turn's execution spawned (`origin_turn_id`); a turn parked on its question is cancelled by withdrawing it |
| Deleting a thread or Work (`stopThreads`: chat trash, Work delete, the work tool, receipt reversal) | each deleted thread's run, every ask it holds and its whole subtree, one lineage per topmost thread. Trash and Work delete run it in their own transaction; receipt reversal runs it after its commit |
| A child's terminal run | its whole subtree, before its claim is released |

`asked` is non-terminal for the last rule, so descendants keep running and their
notifications wait behind the question barrier. Foreground children always follow
their caller's abort signal.
