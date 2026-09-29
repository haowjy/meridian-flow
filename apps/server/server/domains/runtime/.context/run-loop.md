# Run loop

One run is one lease through potentially many LLM-call and tool-execution
iterations and assistant turns. `loop/orchestrator.ts` owns the skeleton and
delegates the moving parts: what enters the run is [delivery](delivery.md),
what the model is sent is [request assembly](request-assembly.md), and how a
run shrinks its history is [compaction](compaction.md).

| File (under `loop/`) | Role |
|---|---|
| `orchestrator.ts` | Builds run-start and next-boundary model context from selected writer messages, durable history, references, skills, and images. It returns durable turn events plus the assistant to reserve; the delivery boundary owns preparation retries, notice consumption, inbox adoption, and atomic commit. `loadRunStartContext` reports a typed fork-history load failure as the `thread.conversation_context.load_failed` warn event and preserves the `thread_context_error` failed-reply path instead of falling back. A mid-run adoption completes assistant A and creates B, preserving graph order. Report admission belongs to the first commit that adopts a directed row, on that commit's reserved turn. Control-only runs admit no report. |
| `run-session.ts` | One owner for writer and child claims, AbortController, current-turn registry, heartbeat, cancel, terminal fallback, and best-effort release. `execute` settles after cleanup; child report publication B follows it. A primary completion aborts foreground descendants only; a child invocation bounds its whole subtree and aborts background descendants too. Explicit cancellation includes background descendants. |
| `run-turn-port.ts` | `prepare(input)` returns a `PreparedRun` with run/initial assistant identity, pre-setup replay cursor, post-setup snapshot floor, and one-shot `execute(): Promise<RunOutcome>`. Setup commits before returning; only execute enters the model loop. The journal/hub is the sole event consumer, not an orchestrator generator. |
| `ports.ts` / `adapters/drizzle-run-claim.ts` | `InboxReader` is read-only; `selectPending` does not claim or mutate. `RunClaim` shares one nonreentrant session advisory claim across `withExclusiveThread` (short admission/Work/recovery work without a lease) and `startExecution` (observable, heartbeating lease). Only delivery binds the current turn (assistant or pending compaction) and receipt. Receipt mutation is guarded by thread/run/holder and exact IDs when clearing; the held session claim, not heartbeat expiry, authorizes a paid response commit. Guarded `cancelExecution(threadId, turnId)` matches any selector bound to the live run under the lease row lock: a prior segment can stop its current successor, but a selector from an ended run cannot stop a new run. Session release deletes only its own lease and physically unlocks after commit; the session owner retains one failure-backstop release. |
| `execution-finalizer.ts` | Terminal transaction projects the current turn event and finalizes the nearest admitted report on the terminal turn's ancestor chain. The report's selector remains its admitted first reserved turn; `terminalTurnId` records the final turn. A pending placeholder can end failed or cancelled, never successful through this finalizer. Fallback text is from that terminal turn’s final persisted response; cost includes terminal responses and every assistant or compaction response back through the selector, so a C that is the selector or terminal is covered once. Run-scoped capture keeps the existing partial-outcome policy except orphaned placeholders, whose child report is empty. Intermediate splits never publish a report. |
| `persistence.ts` | Transactional persist/project-then-emit helper. **Ordering**: `projectReadModelEvent` runs before `eventWriter.appendEvent` so the `event_journal.turn_id` FK can reference the turn row created by the projector. Both happen in the same repo transaction. |
| `tool-dispatch.ts` | Live output, spawn/thread_message/returnResult callback wiring, and durable tool_result persistence. Dispatch does not apply policy. return_result settlement is spawn-owned: dispatch honors the typed `ReturnResultOutcome` and does not parse arguments or reconstruct the envelope from JSON. |
| `streaming.ts` | Maps gateway `StreamEvent`s to `OrchestratorEvent` stream deltas and extracts tool calls. |
| `partial-tool-activity.ts` | Reads only the top-level string fields used by live labels from partial tool-call JSON; it tolerates an unfinished object and ignores nested arguments. |
| `interrupt-session.ts` | Same-turn interrupt suspend/resume mechanics and component-block updates. |
| `interrupts.ts` | `InterruptRegistry` factory; process-local pending interrupt promises plus restart recovery from the event journal. No module-global registry state. |
| `turn-accounting.ts` / `settle-summary-responses.ts` | One `computeAndDebit` path records summary-call cost against the shared tree budget and credits ledger in the transaction that completes, fails, or cancels C or a handoff seed. Row settlement is metadata-neutral; each summary owner writes its own typed metadata. Summary calls do not spend model iterations or the turn budget; the successor's next pre-iteration check sees any exhausted tree cost budget. Handoff settlement is owned outside this loop by the [handoff service](handoff.md). |
| `block-helpers.ts` | Content block conversion and local accumulator helpers. |
| `local-turn.ts` | The one builder for turns that carry no model response (run skeleton, drained messages), so the read model and context projection see a single turn contract. |
| `model-response-timing.ts` | Flattens per-attempt gateway timing into persisted model-response fields. |

## Queue and release wake

`next(pending, at)` in `next-inbox-work.ts` is the one pure selector used by
run start and `wakeIfRunnable`. At a reply boundary it selects every non-control
row. At run start it chooses a stamped command plus waiting messages,
otherwise messages before the oldest command, or one command when no message
waits. This keeps `/compact` and Undo at the end of the queue and prevents
command selection between tools or at reply boundaries ([controls](controls.md)).
Every non-control row, including a Work refresh notice, closes the reply prefix
at a boundary; a notice-only queue still does not start a run.

After a run releases its claim, cleanup refreshes and re-reads the queue through
`wakeIfRunnable`; this includes a run that found nothing to do and a lease
cancelled during setup. If an assistant fails, its initiating input is excluded
from this reread. A command queued behind failed-receipt rows is also suppressed;
the periodic sweep is the retry path for those rows. Newly arrived rows outside
that receipt remain eligible and wake promptly.
An empty reread does not start a run. A real setup error skips the reread to
avoid a hot loop. Short exclusive claim holders still use the sweep as their
liveness backstop.

The runtime composition owns one `DetachedWorkTracker` shared by run sessions,
delivery callbacks, background child completion, and handoff briefs. Cleanup
wakes, detached drain execution, lease-renewal I/O, brief launches/polls, and
post-commit runtime work register with it. `drain()` waits for tracked work and
work registered before the tracker becomes quiescent. App shutdown sets the
shared shutdown flag before aborting live runs and briefs with the `shutdown`
reason. Run starts and wakes are suppressed after that point; live replies
settle paid response rows before releasing their claims. The app waits for one
bounded 10-second drain and warns if it times out. A brief launched after
shutdown begins leaves S pending for ordinary repair, and a released claim does
not wake its destination. DB test fixture resets drain the explicitly wired
test tracker before locking and deleting tables.

`OrchestratorDeps` requires the runtime ports: gateway, repos, retained Agent
revision reader, tool registry/executor, project preferences, credit ledger, the
`RuntimeDelivery` boundary, the `RunClaim`, interrupt artifact flush,
child-run coordinator, interrupt registry, and `EventSink`. `backgroundTasks`
is required and injected by the app composition or test harness. The process
tracker is explicitly wired only into DB test fixtures. Disabled behavior is
an explicit adapter (for example a no-op sink), never an omitted dep. Do not
re-add a global permission gate here; names and per-tool command sets are gated
per turn from advertised policy
([tools](tools.md)). Provider-specific model-call behavior stays behind the
gateway port.

Handoff brief generation is not a run: the orchestrator only delegates Stop
for a pending seed to `HandoffBriefs`. Launch, provider calls, seed settlement,
and recovery live in the independent [handoff service](handoff.md).

## Invariants

- **Max 32 iterations** per turn (`MAX_TURN_ITERATIONS`). Exceeding this
  finalizes the turn with an error.
- **Cancellation via `AbortSignal`**, checked before model calls, after stream
  events, and around tool execution. Cancellation finalizes the turn as
  `cancelled` and sets the thread back to `idle`. The run signal (with the
  durable cancel request) is the only cancel authority; see
  [compaction cancellation](compaction.md#current-turn-and-cancellation).
- **Persist/project-then-emit.** Every state mutation goes through
  `persistAndAppendEvents` before any event is yielded to subscribers. Within
  the transaction, `projectReadModelEvent` runs first (creating
  turn/block/model-response rows), then `eventWriter.appendEvent` appends to
  the journal (satisfying the `event_journal.turn_id` FK).
- **Tool execution** is parallel by default; registrations marked
  `sequential: true` run serially after parallel tools complete. Timeout and
  abort races are handled by the executor.
- **Model response lifecycle.** `persistModelResponse` mints the response id
  used by tool handlers. After all tool results for that response are
  persisted, the orchestrator commits response-scoped agent-edit writes.
  Staged tool results finalize in the same database transaction as that commit
  using the settled receipts returned by agent-edit, never the speculative
  staged output. A host-only settlement id correlates each tool call to its
  receipt; the model-facing write handle is not unique within a response. A
  staged result left by a pre-commit process failure becomes a typed rejection
  before a later turn assembles model context. Durable orphan recovery
  recognizes that state only when the persisted block is marked as a staged
  write, its output passes the canonical `isAgentEditResult` guard, and the
  discriminated result phase is `staged`; a schema string alone is not
  sufficient. Cancellation paths roll the response buffer back before
  finalizing the turn as cancelled.
- **Response write settlement is report-only.** Ordinary Yjs merge always
  commits. Destructive effects are echoed to the model and writer-lineage
  overlap may elevate receiving-writer-specific session marks. Trail evidence
  stays lifecycle-neutral and read-only.
- **Production runners hold the cross-process claim through completion
  delivery.** A crashed process loses its session claim, so recovery can
  safely take over its orphaned work ([recovery](recovery.md)).
