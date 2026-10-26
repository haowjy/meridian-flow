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
`findByContinuationAsk` returns the latest report for the ask. The foreground
caller drives the continuation if its row is pending, else waits by ask id, outside
any lock, until the latest report is terminal and no row for the ask is pending.
It wakes on the child's committed thread events, and a replay waits the same way.

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
Terminal persistence precedes helper/Work cleanup, and a child terminal run
aborts its descendants and cancels their parked asks through database lineage.
`asked` is non-terminal for this lifetime rule, so descendants keep running and
their notifications wait behind the question barrier.
