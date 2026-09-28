# Spawn and child runs

Nested agents: creating and driving a child, messaging an existing thread,
the parent's invocation card, activity, and the child's report. A child seeded
with `from` gets a frozen reference, not history; see
[history tools](history-tools.md).

## Vocabulary

- **spawn** = the act exposed by the tool and emitted events.
- **child run** = the supervised execution (`ChildRunCoordinator`, child-run registry).
- **subagent thread** = the thread kind and creation seam (`SubagentThreadFactory`).

These are one concept-cluster with three facets; use each name only for its
facet.

## Coordinator and driver

`spawn/child-run-coordinator.ts` owns nested-agent policy and exposes one
`runChild(request, { mode, transcript })` entrypoint, where `request.kind`
discriminates spawn from message. It authorizes, resolves the invocation,
creates and binds the child thread, and persists writer cards. `spawn/resolve-child-invocation.ts`
is the pure resolution/validation half (no thread, turn, or repository
dependency). `spawn/child-run-driver.ts` supplies admission input to the shared
run session, binds the parent card before execution, then reads the exact saved
result and publishes after the session releases. It owns no lease or terminal
report policy. `loop/execution-finalizer.ts`
owns immutable terminal transaction A under `closeRun`'s child final-drain lock.
`spawn/report-publisher.ts` owns parent-first transaction B: it replaces the
original card in place with `block.updated`, appends body-free
`agent.run_completed`, queues compact child-provenance notice text for
background delivery only (`Subagent pN finished (outcome). Read its report with
thread_report({"ref":"pN"}).`), and marks the report published. Internal execution UUIDs never enter the model surface.
`spawn/orphan-report-repair.ts` hosts the orphan sweep; who repairs what is in
[recovery](recovery.md). Child-report repair finalizes placeholders before
walking the child chain, treating every admitted execution selector as a
barrier, including compaction selectors.

## Invocation and configuration

The coordinator consumes `RunTurnPort` through its driver,
immutable Agent revisions, and the threads repository's
`SubagentThreadFactory` seam. `spawn/apply-invocation-patch.ts` parses the patch with the canonical `invocationPatchSchema` and translates a `ZodError` to `InvocationPatchError`, so an unknown key or wrong value reaches `spawn_invocation_patch_invalid` before any child row is created. It then merges a presence-sensitive `InvocationPatch` onto a fully-resolved baseline (omitted inherits, present list replaces, empty clears, tool map patches one entry, scalar `model`/`effort` replace) through the compile-time-exhaustive `PATCH_MERGES` table, one entry per patch key; `tools` and `disallowed-tools` are coupled and each returns the full `patchTools` result so a map `allow` lifts the baseline denial. Overrides fold tool-name aliases like authoring. Added subagent names resolve from the caller's roster and added skill names from the retained dependency graph, throwing `InvocationPatchError` when unresolvable. The patch applies to named and generic children alike. The effective configuration plus the raw `invocation_overlay` persist on the thread binding and are reused on later turns; the saved Agent definition is never mutated. A spawn-time `append_system_prompt` is an additive overlay layer appended after the immutable Agent body; spawn never replaces the body. Route-facing
thread creation still goes through public thread creation normalization; only the
child-run coordinator can create subagent threads.

## `thread_message`

`thread_message` puts a message into an existing thread instead of creating one:
`runChild` with `kind: "message"` authorizes through
`spawn/authorize-thread-message.ts`, which resolves the model's `pN`/`cN` ref
with the project-scoped `findLiveByProjectRef` (same project and user) and then
checks `threads/domain/lineage.ts` — **background** requires `sameLineage` (same
project and `rootThreadId`, forks included), **foreground** requires
`isInSubtree` (the target is the caller or a descendant, walking
`parentThreadId`) so a wait cannot cycle on an ancestor. A malformed or missing
ref → `thread_message_target_not_found`; an out-of-lineage/out-of-subtree ref →
`thread_message_not_authorized`. Background delivery is a queue producer only:
the coordinator enqueues one `agent`-provenance `message` through the
producer-facing `RuntimeDelivery` (idempotency key `thread-message:<toolCallId>`)
and returns `{ status: "background" }` without driving anything — the target's
own run drains it and wakes if asleep. Foreground is the existing child wait
path: the coordinator's `prepareForegroundMessage` loads the target's frozen
binding for `resolvedSlug` only and never re-resolves configuration — so
`thread_message` carries no configuration patch and cannot escalate the target's
model, tools, system prompt, or overlay. A binding-less target fails
`thread_message_target_unavailable`; a live writer turn or overlapping run fails
`thread_message_target_busy`. The driver's `register` owns only the
claim/controller/registry, so a failed foreground message never writes the
child's lifecycle; the caller owns the failure policy.

## Cards and results

Invocation helper-result cards persist through `spawn/spawn-transcript.ts`
as one parsed `InvocationCardProps` contract. Their name is the bound Agent
revision's `metadata.name`, falling back to its slug (the generic unbound
subagent keeps its canonical display name). Running cards have `terminalAt: null`
and keep the parent turn, tool call, child thread, delivery mode, and nullable
execution until admission binds the first committed reservation. Terminal cards
carry `outcome` plus `terminalAt`, not a duplicate status. A pre-admission
failure carries a writer-readable `reason` and intentionally has no child thread
or execution link. The parent-lock-scoped admission replacement and publication
B preserve the exact tuple and original block id/turn/sequence; neither carries
report body. A spawned background
execution returns only after execution admission commits, without waiting
for terminal. Foreground spawn and message return the exact terminal report
directly, preserving failure/cancellation and partial content. Background
`thread_message` remains queue-only with no promised execution or reply. The
original card is bound at admission and terminally replaced by B; a missing card is not recreated,
but a live caller still receives the notification. `return_result` captures
candidate content with its successful ordinary `tool_result` in one
transaction; capture alone never makes success. `spawn_status` remains a
lifecycle hint for activity readers, while the removed `spawn_result` column is
not a competing body store. Every child run publishes neutral, body-free
`agent.run_completed` metadata; there is no spawn-named completion event.

## Activity

Create and terminal also append a neutral `subagent.activity` fact to the child's
**direct parent's** journal, carrying that parent's recomputed direct-child
`ThreadActivity`. A foreground `thread_message` appends it once the wake lease is
held, and a drain-woken run (a child report or background `thread_message`) is
driven by the turn runner, which appends at lease acquire and again at lease
release so the strip reads awake for the whole run and asleep after. While a
subagent response streams, the first `tool_call.delta` records its call name
and best-effort partial input on the lease (`thread_run_leases.current_tool`,
via `RunClaim.setCurrentTool`); one further refresh records the target once a
document path/URI, search pattern, or spawn agent arrives. A `write` skips the
first-delta record and waits for its command as well as its path, because the
same tool reads, diffs, and edits; labeled early, every read would flash as a
write. Other deltas do not write activity. Tool dispatch still records the full input and appends the same
activity fact only when the call changed. The
create-side append is strict (a failure fails the spawn), while terminal and
wake appends are best-effort: a read-model failure is reported to the
`EventSink` (`subagent.activity.append_failed`, or
`subagent.activity.emit_failed` for a failed thread lookup) and never gates the
run or writes a contradictory terminal fact. The read-model
projector ignores it; the orchestrator event
projector maps it to the `meridian.subagent.activity` custom frame.

## Named and generic children

Named targets resolve by name within the parent binding's roster; a target with
`model-invocable: false` is refused, while a primary-mode target is spawnable.
An omitted or empty `agent` creates an agent-less child: the binding has no
Agent revision (`definitionRevisionId` null), the body is the host-owned empty
`GENERIC_AGENT_BODY`, and the child copies the caller's resolved configuration,
including `tools`, `disallowed-tools`, and `effort`. Named children resolve
those fields from their own retained revision. A nested generic keeps the
ancestor's write deny because it copies that configuration. Turn context reads
tools and effort from configuration only.
Max spawn depth defaults to 3, overridable only through operator env at tree creation. Child
creation, Agent binding, and Work membership share one transaction. The child starts with an unfrozen
prompt; ordinary turn preparation adds its retained persona and mandatory report
instruction. Terminal lifecycle/result persistence precedes helper/Work-context
cleanup, so cleanup failure preserves the completed report. A child's terminal run
aborts that child's own descendants (background runs included): a background
descendant cannot outlive the subagent that spawned it, and long-lived watchers
belong to the parent.

## Reports

A child run's report is admitted once, finalized with its terminal turn, and
published to the parent from that durable row. `ChildDriveInput.reportCorrelation`
carries only the caller/turn/tool/card and origin/delivery metadata; the
child's `executionTurnId` is assigned only after turn admission. The model reads
a report with `thread_report` ([history tools](history-tools.md)); tool and API
responses share the `ThreadReportResult` contracts schema, including
`childThreadId`, and the app projects both through `toReportContentValue`.
