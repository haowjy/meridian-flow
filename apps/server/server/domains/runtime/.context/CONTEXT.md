# domains/runtime — orchestrator, model gateway, tools, spawn

The agentic execution engine. It takes a user message, streams it through an LLM
with tool use, persists side effects through thread repositories, and emits
`OrchestratorEvent`s that the threads domain fans out to clients.

## gateway — multi-provider LLM abstraction

Normalizes Anthropic, OpenAI, and OpenAI-compatible providers behind a single
streaming `Gateway` port.

| Concern | Detail |
|---|---|
| `Gateway` port | `stream(request) -> AsyncIterable<StreamEvent>`, `generate(request) -> GenerateResult`, optional `settleCancelledResult()` and `listModels()` |
| `ProviderAdapter` port | per-provider streaming implementation (Anthropic, OpenAI Responses, OpenAI-compatible) |
| Routing | `ProviderRegistry` maps model IDs to adapters; `resolveRoute` picks adapter + model for a request |
| Retry/fallback | exponential back-off and optional ordered fallback only before **committed** output has been emitted. Committed output is visible text or a tool call; reasoning deltas and usage are process-only, so a reasoning-only abort is retryable |
| Deadline | per attempt, two timers on one derived `AbortSignal`: an inactivity (stall) timer re-armed by every stream event (`GatewayConfig.attemptStallMs`, env `MODEL_CALL_STALL_MS`, default 60s; never kills a slow-but-streaming model) and an absolute ceiling backstop (`GatewayConfig.attemptCeilingMs`, env `MODEL_CALL_TIMEOUT_MS`, default 15 min / 900s, 0 disables). Per-model `stallTimeoutMs`/`ceilingTimeoutMs` override the gateway values. Retry/deadline driver lives in `attempt-stream.ts`; the signal lives in `deadline.ts` |
| Cancel drain | After partial output, a parent cancel may drain usage/end events, but one absolute five-second deadline from abort bounds that drain even after a rejected read. `attempt-stream.ts` owns one abort listener per attempt and clears its timer/listener on exit; iterator `return()` is observed without awaiting it, so a hostile adapter cannot hold cancellation or retry hostage. |
| Config | `GatewayConfig` with provider list, default model, retry/fallback/`attemptStallMs`/`attemptCeilingMs` policy; `createGatewayFromEnv` for env-driven setup |
| Registry | `MODEL_REGISTRY` in `config/registry.ts` — single-source for config + pinned pricing. `buildFromRegistry` composes providers. Flat `MODEL_TOKEN_RATES` table is **deleted**. |
| Collision warning | `onWarning` callback on registry construction warns on duplicate model IDs (was last-writer-wins silently). |
| Usage normalization | Adapters own the conversion into canonical `Usage` and call `assertValidUsage` before returning. Providers disagree on what `inputTokens` counts: OpenAI reports an inclusive total, Anthropic reports uncached input and each cache counter as separate additive categories. An adapter that passes additive counters through unchanged underbills every cached turn — see issue [#356](https://github.com/haowjy/meridian-flow/issues/356). |
| OpenRouter | `openrouter` adapter reuses the OpenAI-compatible wire shape and owns provider-reported cost enrichment via `/generation`. |
| Cancel settlement | `Gateway.settleCancelledResult()` owns interrupted-call reconciliation and persist decisions. Generic token/missing-usage handling lives in `gateway/domain/cancel-settlement.ts`; OpenRouter-specific `/generation` settlement lives under `gateway/adapters/openrouter/`. The loop only asks the gateway to settle and then finalizes cancellation. |
| Tool-arg JSON repair | `gateway/helpers/parse-tool-arguments.ts` repairs malformed provider JSON (e.g. unquoted hex hash `"in": 6c4a`) via `jsonrepair` before falling back to a typed `ToolArgsParseError` sentinel. Unrepairable input surfaces a clear model-actionable parse error instead of degrading into misleading downstream schema errors. See issue [#113](https://github.com/haowjy/meridian-flow/issues/113). |
| Instrumentation | `instrumented-gateway.ts` decorates the `Gateway` port once in `createProductionAppPorts` (`lib/compose.ts`), emitting `gateway`-source lifecycle events (`stream.open`/`first_output`/`retry`/`close`; per-chunk only under `OBS_VERBOSE=gateway.chunks`, dev/test-only) keyed by `correlation.gatewayCallId`. A `Gateway` constructed outside that seam bypasses instrumentation — intentional for tests, wrong for production consumers. Verbosity is resolved from the injected environment at that seam (`resolveObsVerbose({ rawNodeEnv, obsVerbose })` in `lib/compose.ts`), not a module-level `process.env` read — tests inject `OBS_VERBOSE`; a module-level const would bypass them. |
| Model-request inspection | Immediately before `Gateway.stream()`, the orchestrator offers the provider-neutral `GenerateRequest` to a capture port. Disabled capture does not serialize it. Local dev/test capture shares `gatewayCallId` with lifecycle events and retains at most 200 records, 2 MiB per request, and 16 MiB total; exact-call reads include the preceding request for prefix comparison. The gate cannot enable capture in staging or production, and content never enters `EventSink`, thread snapshots, the event journal, or JSONL. |

Canonical gateway types live in `gateway/domain/types.ts`.

## loop — orchestrator + run sessions

One run = one lease through potentially many LLM-call + tool-execution
iterations and assistant turns. The loop is intentionally decomposed; `orchestrator.ts` owns the
skeleton and delegates the moving parts.

| File | Role |
|---|---|
| `orchestrator.ts` | One admitted run may span several assistant turns. At a safe boundary, adopting directed messages completes A, appends/adopts message turns, creates B, and rebinds the held lease in one thread-locked transaction. Requests use A → messages → B graph order. Durable Work refresh notices also split; ordinary request-only notices do not. Response+ack clears the lease receipt; cancel retires adopted IDs only, leaving later messages for a new run. The locked final claim uses the same split transition, not a second continuation path. Report admission happens only at run setup, and terminal finalization only at run exit. |
| `inbox-context.ts` | Materializes a claimed batch as durable turns/blocks, notices, and request-only skill bodies keyed by adopted writer turn. Existing writer turns are adopted without a second append; `prepareAdoptedTurn` persists their missing text-reference reads. `planMessageTurns` and `messageTurnFor` own fresh message history. Child completions persist a system turn with `{ kind: "subagent_update", handle, outcome, execution }` metadata; the execution UUID is for internal card correlation only. The loop accumulates these turns and skill bodies, then the shared context assembler renders them. Never splice a second inbox rendering over the assembled request: that bypasses image authorization, model capability, and the whole-request occurrence budget. |
| `runtime-delivery.ts` / `adapters/runtime-delivery.ts` | One domain delivery boundary owns locked enqueue, initial batch adoption, response+ack, A → messages → B split and terminal close. The concrete Drizzle adapter joins all writes to one ambient transaction and appends the classified pending replacement before commit. Journal failure rolls the transition back; only the physical wake is best-effort after commit. Recovery and backstop release refresh through this same append path so expired queues reclassify live. Close locks the lease receipt before deciding whether to split or terminalize, honoring a remote cancellation accepted during the final model call. Publication B uses its scoped parent producer without reacquiring the parent lock. |
| `run-starter.ts` / `sweep-wakes.ts` | The wake actuation seam. `createRunStarter` maps `RunStarter.start` to the turn runner's `startDrain`, handling `TurnStartConflictError` quietly and reporting unexpected failures once through EventSink because a wake is best-effort. `sweepWakes` is the durable recovery: it keyset-pages pending threads in stable thread-ID order, batch-reads live leases, and starts eligible threads with bounded concurrency. Its caller retains the returned cursor across sweeps; an empty suffix wraps to the first page. One candidate’s failure is reported without stranding the rest. `app.ts` registers the sweep with the process recovery scheduler at boot, then rearms it after completion with `WAKE_SWEEP_INTERVAL_MS` (default 30s). The `enqueue` wake is the latency path; the sweep is the guarantee. |
| `thread-lock.ts` | Short per-thread transaction serialization, distinct from the session run claim. Delivery acquires the advisory lock, then the shared `NO KEY UPDATE` thread row lock before enqueue or consumption/close. Work rows follow the thread row in sorted id order through `shared/thread-work-lock.ts`; publication parent locking and writer admission use the same order. Work-only notice insertion takes no thread mutation/advisory lock, only compatible FK `KEY SHARE`. No provider call runs under these locks. |
| `block-helpers.ts` | Content block conversion and local accumulator helpers. |
| `turn-accounting.ts` | Credit ledger checks/debits and cumulative usage events. |
| `interrupt-session.ts` | Same-turn interrupt suspend/resume mechanics and component-block updates. |
| `tool-dispatch.ts` | Live output, spawn/thread_message/returnResult callback wiring, and durable tool_result persistence. Dispatch does not apply policy. return_result settlement is spawn-owned: dispatch honors the typed `ReturnResultOutcome` and does not parse arguments or reconstruct the envelope from JSON. |
| `run-turn-port.ts` | `prepare(input)` returns a `PreparedRun` with run/initial assistant identity, pre-setup replay cursor, post-setup snapshot floor, and one-shot `execute(): Promise<RunOutcome>`. Setup commits before returning; only execute enters the model loop. The journal/hub is the sole event consumer, not an orchestrator generator. |
| `run-session.ts` | One owner for writer and child claims, AbortController, current-turn registry, heartbeat, cancel, terminal fallback, and best-effort release. `execute` settles after cleanup; child report publication B follows it. A primary completion aborts foreground descendants only; a child invocation bounds its whole subtree and aborts background descendants too. Explicit cancellation includes background descendants. |
| `interrupts.ts` | `InterruptRegistry` factory; process-local pending interrupt promises plus restart recovery from the event journal. No module-global registry state. |
| `context-builder.ts` | Builds `Message[]` + `Tool[]`; sends frozen `composedSystemPrompt` verbatim when baked; formats transient safety notices injected by the orchestrator. Child-provenance system text contains a compact exact `thread_report` call, never the report body; the parent model may fetch that report with the authorized tool. Assistant custom blocks stay UI-only to preserve tool_use→tool_result adjacency. |
| `composed-system-prompt.ts` | Assembles and re-bakes the gateway system prompt in a fixed layer order: immutable agent body (revision body or the host-owned empty default), the invocation overlay's additive `appendSystemPrompt`, frozen Work context, available skill slugs (name when it differs) and descriptions, named subagent slug/name/description from the bound roster, core document dialect, runtime URI instruction, and, for subagent threads only, the mandatory closing report instruction as the last layer. An empty or absent append adds nothing, and the guidance string is a module constant (`SUBAGENT_GUIDANCE`). Freeze sentinel is `bakedSkillSlugs !== null`. Frozen at first turn attempt (context assembly), even if the send fails or is cancelled; autoprune is the only future re-bake trigger. |
| `work-context.ts` / delivery adapter | Renders authoritative Work state. Mutations enqueue immutable system-provenance refresh notices in the business transaction. The delivery boundary coalesces a batch into one durable system update and event and acknowledges its notice IDs atomically. Idle recovery uses a short run claim; notices never wake a model. |
| `ports.ts` / `adapters/drizzle-run-claim.ts` | `InboxReader` is read-only; `selectPending` does not claim or mutate. `RunClaim` shares one nonreentrant session advisory claim across `withExclusiveThread` (short admission/Work/recovery work without a lease) and `startExecution` (observable, heartbeating lease). Only delivery binds the current assistant and receipt. Receipt mutation is guarded by thread/run/holder and exact IDs when clearing; the held session claim, not heartbeat expiry, authorizes a paid response commit. Guarded `cancelExecution(threadId, currentTurnId)` cannot cancel a successor run or a steered segment through a stale turn ID. Session release deletes only its own lease and physically unlocks after commit; the session owner retains one failure-backstop release. |

| `system-instructions/` | Model-facing prompt assets independent of any agent body. `document-dialect.ts` owns Meridian document language and its codec-backed spelling contract; `runtime-uris.ts` owns context namespace guidance. Tool descriptions continue to own mechanics. |
| `streaming.ts` | Maps gateway `StreamEvent`s to `OrchestratorEvent` stream deltas and extracts tool calls. |
| `execution-finalizer.ts` | Terminal transaction projects the current assistant event and finalizes the one admitted report found on its ancestor chain. The selector stays the first assistant; `terminalAssistantTurnId` records the final assistant. Fallback text is from that terminal turn’s final persisted response; cost sums every assistant response from selector to terminal. Run-scoped capture keeps the existing partial-outcome policy. Intermediate splits never publish a report. |
| `persistence.ts` | Transactional persist/project-then-emit helper. **Ordering**: `projectReadModelEvent` runs before `eventWriter.appendEvent` so the `event_journal.turn_id` FK can reference the turn row created by the projector. Both happen in the same repo transaction. |
| `admission/` | `UserTurnAdmission` owns writer replay, canonical fingerprinting, exact ordered text/reference/image parsing, project-final authorization with in-place text degradation for unavailable reference identity, lookup, and retirement. Admission is **validate → record → enqueue**: `admission/writer-turn-producer.ts` is the producer. It persists the writer's user turn + blocks at enqueue (reusing the inbox message id as the turn id), stamping any activated `/skill` slugs as hidden turn metadata the serving drain reads back, and appends the writer-provenance `message` in the same turn-start transaction, settling the admission ledger, upload consumption, and document attachment atomically; the wake is best-effort. Liveness is the runner map, never durable turn status: a mid-run send yields the runner's live assistant turn id (a crash-orphaned `streaming` turn and a `waiting_interrupt` run classify correctly), a fresh run yields null and the client learns the turn from `RUN_STARTED`. The producer reads durable rows only as a fallback inside the runner's setup window, scoped to turns created after the run started. An admission winner rolls the whole turn-start transaction back instead of committing a losing or rejected submission. `admission-turn-starter.ts` and `TurnRunner.startTurn` are gone. |
| `reference-context.ts` | Before the first model call, loads admitted current-turn text references through the host-wired shared agent-edit read operation; a mid-run adopted writer turn's unread references load at adoption. Reads run outside admission/persistence transactions; results are persisted server-side at `reference.read.result` before gateway submission. Duplicate `(documentId, uri)` identities read once per turn; replay reuses the frozen result, while a later mention reads afresh. Images retain their separate projection, and client admission rejects `read` payloads. |
| `image-context.ts` / `ports/image-asset.ts` | Late image bytes are identity-resolved after admission, read-deduplicated, and quietly omitted without losing writer text. `projectImageBlocksForModel` runs once per assembled request over history and adopted turns together, spending the occurrence budget newest-first. Projection is request-only: durable and accumulated blocks keep their `image_reference` identity, never bytes. |
| `permissions/` | `projectToolPolicy` projects compiled Mars `tools` / `disallowed-tools` onto Flow tool names and command sets (`write`, `work`). `write` is always advertised with `read` and `diff`; existing `edit` policy adds or removes mutation commands. `advertiseTools` uses that same command set to narrow both the schema and `write` description, so denied-command instructions are not exposed. Retained historical `read` policy metadata is inert. `commandSetForTool` is the single command mapping. Advertise and the per-turn permission gate (name + command) use that policy. `invocation-authority` validates that an invocation patch never grants the child more than the caller holds, applied only to the patch delta. Dispatch does not apply policy. The core catalogue stays policy-free. |

`OrchestratorDeps` is fully required: gateway, repos, retained Agent revision reader, tool
registry/executor, project preferences, credit ledger, the `RuntimeDelivery` boundary, the `RunClaim`, interrupt artifact flush, child-run coordinator, interrupt
registry, and
`EventSink` are all explicit dependencies. Do not re-add a global permission
gate here; names and per-tool command sets are gated per turn from advertised policy. Provider-specific
model-call behavior stays behind the gateway port. Disabled behavior is
represented by explicit adapters (for example no-op sinks), not by omitted deps.

## Bound Agent preparation

`agent-thread-context.ts` reads the immutable thread binding for the persona
and diagnostic Agent identity. The Agent body is always the retained revision's
`systemPrompt` (or the host-owned empty default for an agent-less child); a
spawn-time `appendSystemPrompt` is a separate additive layer, never a
replacement. Tools and effort come from the bound
configuration, never definition metadata. `mapAgentEffortToReasoning` (with
`EFFORT_TO_REASONING`) is the single bridge from canonical `AgentEffort` to the
gateway's provider-neutral `GenerateRequest.reasoning`. Missing bindings fail before a
gateway call. Catalog removal or advancement leaves continued execution on its
retained revision. `turn-context-assembly.ts` supplies that persona to the initial
host-prompt bake and reuses the frozen prompt on later turns; preview shares this
  assembly without persisting. Slash (`/` and Send `activatedSkillSlugs`) lists
every user-invocable `skills/<slug>/SKILL.md` from system and owner package
installations (each walked with `retainedPackageSkillMaps`) plus account
installs; first installed package file wins slug collisions, and package files
win over account rows. The bound Agent package is not the slash catalog.
Prompt bake
and the `skill` tool use bound Agent `skills.available` only (name and
description from retained `SKILL.md`), dropping `model-invocable: false`.
Account installs never join the prompt or `skill()`. `skills.load` is not
injected into first-turn context; nonempty `load` refuses selection. Writer's
load list is empty. The first-bake CAS writes those Agent-available slugs (`[]`
when the Agent list is empty). Later turns send `composedSystemPrompt`
verbatim. Skills that join slash after freeze do not rewrite the prompt or
`bakedSkillSlugs`. Compact rebakes the model catalog. Display slugs do not
guard prompt freezing. The model comes from conversation-owned resolved
configuration, including a frozen default when source omits it. Nonempty
`skills.available` does not refuse selection or turn preparation. A nonempty
`subagents` roster no longer refuses selection. `spawn` and `thread_message` are
advertised to every Agent; Mars `tools` cannot hide them. Named targets come
from the binding's roster, baked into the frozen system prompt like available
skills (not listed on the spawn tool), and an omitted or empty `agent` selects
the agent-less generic subagent.

## tools — registry, executor, and handlers

| Concern | Detail |
|---|---|
| `ToolRegistry` | Name-keyed map. Duplicate names throw immediately. `getDefinitions()` advertises only server-executable registrations whose `advertise !== false`. |
| `ToolExecutor` | Dispatches `ToolCallInput` to registered handlers with timeout, abort, sequential execution, and capability-gated context injection. |
| `ToolRegistration` | `source: "core" | "spawn" | "skill"`, `definition`, `execution`, optional `timeoutMs`, `sequential`, `advertise`, one privileged `capability`, and optional `formatExecutionError` when a tool owns its model-facing error protocol. |
| Core handlers | The strict six-branch `work` union, the single `write` document definition, and other definitions live in `tools/core-tools.ts`; composition wires their handlers through `lib/wired-core-tools.ts`. |
| Skills | References are retained at binding. `createSkillToolRegistrations` registers the `skill` tool (`source: "skill"`); invoke loads a SKILL.md body only when the slug is in Agent `skills.available` and `model-invocable` is not false. No legacy `invoke` registration or mutable skill catalog participates in preparation. |
| Spawn tools | `tools/spawn-tools.ts` registers `spawn`, `thread_message`, and `return_result` with explicit privileged capabilities. `thread_message` `{ ref, message, mode }` puts a message into a thread (default `mode: background`); foreground targets a subagent in the caller's subtree and returns its report. Neither spawn nor thread_message accepts an escalation patch. |

Handler-owned `{ isError: true, output }` results already define their
model-facing protocol, so the executor preserves their output by definition.
Parse, timeout, abort, and thrown failures belong to the executor; it delegates
those to the registration's `formatExecutionError` when present and otherwise
uses the generic Meridian error format. The canonical `write` registration owns such a
formatter so every executor-owned document failure still returns
`meridian.agent-edit.v1` without teaching the generic executor about agent-edit.

The core-tool publication boundary lives in `tools/core-tools.ts`: definitions,
names, and constraints are canonical there, but `createCoreToolRegistrations()`
requires handlers for every core tool. The composition root supplies executable
behavior; schema-only stubs are not advertised.

## spawn / child runs

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
thread_report({"ref":"pN"}).`), and marks the report published. The model can
request an earlier 1-based child run with optional `run`; internal execution
UUIDs do not enter the model surface. `context-builder.ts` emits every persisted
system-role history turn in place as a user message wrapped once in
`<system_update>`. Only the actual thread system prompt uses the provider
system field; adapters merge adjacent user messages as required by Anthropic.
Writer sends persisted for inbox adoption carry `kind: "inbox_message"`; the
client keeps them visible with their inline queue state until adoption, then
places them with other inbox updates inside the preceding assistant turn.
`spawn/orphan-report-repair.ts` scans bounded unfinalized metadata and requires
the real session claim before failing a nonterminal admitted turn without a
model call. The process scheduler runs wake, repair, and publication in separate lanes
independently. The coordinator consumes `RunTurnPort` through its driver,
immutable Agent revisions, and the threads repository's
`SubagentThreadFactory` seam. `spawn/apply-invocation-patch.ts` parses the patch with the canonical `invocationPatchSchema` and translates a `ZodError` to `InvocationPatchError`, so an unknown key or wrong value reaches `spawn_invocation_patch_invalid` before any child row is created. It then merges a presence-sensitive `InvocationPatch` onto a fully-resolved baseline (omitted inherits, present list replaces, empty clears, tool map patches one entry, scalar `model`/`effort` replace) through the compile-time-exhaustive `PATCH_MERGES` table, one entry per patch key; `tools` and `disallowed-tools` are coupled and each returns the full `patchTools` result so a map `allow` lifts the baseline denial. Overrides fold tool-name aliases like authoring. Added subagent names resolve from the caller's roster and added skill names from the retained dependency graph, throwing `InvocationPatchError` when unresolvable. The patch applies to named and generic children alike. The effective configuration plus the raw `invocation_overlay` persist on the thread binding and are reused on later turns; the saved Agent definition is never mutated. A spawn-time `append_system_prompt` is an additive overlay layer appended after the immutable Agent body; spawn never replaces the body. Route-facing
thread creation still goes through public thread creation normalization; only the
child-run coordinator can create subagent threads.
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

Invocation helper-result cards persist through `spawn/spawn-transcript.ts`
with the original parent turn, tool call, child thread, delivery mode, and a
nullable execution until admission binds the committed assistant turn. The
parent-lock-scoped admission replacement and publication B preserve that exact
tuple and the original block id/turn/sequence; neither carries report body.
An unadmitted failure keeps `execution: null`. A spawned background
execution returns only after assistant-turn admission commits, without waiting
for terminal. Foreground spawn and message return the exact terminal report
directly, preserving failure/cancellation and partial content. Background
`thread_message` remains queue-only with no promised execution or reply. The
original card is bound at admission and terminally replaced by B; a missing card is not recreated,
but a live caller still receives the notification. `return_result` captures
candidate content with its successful ordinary `tool_result` in one
transaction; capture alone never makes success. `spawn_status` remains a
lifecycle hint for activity readers, while the removed `spawn_result` column is
not a competing body store. Every child run publishes neutral, body-free
`agent.run_completed` metadata; there is no spawn-named completion event. Create and terminal also append a neutral `subagent.activity` fact to the
**root** thread's journal (not the immediate parent), carrying the root's full
recomputed `ThreadActivity` so every subscriber of the run tree shares one
activity source. A foreground `thread_message` appends it once the wake lease is
held, and a drain-woken run (a child report or background `thread_message`) is
driven by the turn runner, which appends at lease acquire and again at lease
release so the strip reads awake for the whole run and asleep after. The
create-side append is strict (a failure fails the spawn), while terminal and
wake appends are best-effort: a read-model failure is reported to the
`EventSink` (`subagent.activity.append_failed`, or
`subagent.activity.emit_failed` for a failed thread lookup) and never gates the
run or writes a contradictory terminal fact. The read-model
projector ignores it; the orchestrator event
projector maps it to the `meridian.subagent.activity` custom frame.
Named targets resolve by name within the parent binding's roster; a target with
`model-invocable: false` is refused, while a primary-mode target is spawnable.
An omitted or empty `agent` creates an agent-less child: the binding has no
Agent revision (`definitionRevisionId` null), the body is the host-owned empty
`GENERIC_AGENT_BODY`, and the child copies the caller's resolved configuration,
including `tools`, `disallowed-tools`, and `effort`. Named children resolve
those fields from their own retained revision. A nested generic keeps the
ancestor's write deny because it copies that configuration. Turn context reads
tools and effort from configuration only.
Max spawn depth
defaults to 3, overridable only through operator env at tree creation. Child
creation, Agent binding, and Work membership share one transaction. The child starts with an unfrozen
prompt; ordinary turn preparation adds its retained persona and mandatory report
instruction. Terminal lifecycle/result persistence precedes helper/Work-context
cleanup, so cleanup failure preserves the completed report. A child's terminal run
aborts that child's own descendants (background runs included): a background
descendant cannot outlive the subagent that spawned it, and long-lived watchers
belong to the parent.

Step 2 exposes `thread_report({ ref, execution })` as an ordinary advertised
tool. It resolves one saved assistant-turn report through the threads
repository and applies live caller/project/lineage authorization in one
root repeatable-read snapshot. The selector uses the canonical request-ID grammar;
`not_ready` requires the requested execution to own the assistant currently
bound to the live run lease (resolved through graph ancestry). An admitted but unbound or older nonterminal run is `unavailable`. `ChildDriveInput.reportCorrelation` carries only the
caller/turn/tool/card and origin/delivery metadata; the actual child
`assistantTurnId` is assigned only after turn admission. The runtime admits
each child run once, finalizes its saved report with the terminal assistant turn,
and publishes a parent card/notification from that durable row. Generic
`ThreadPendingInbox` projects every provenance; the writer-only tray selector
must filter `provenance.kind === "writer"` on the client.

### Vocabulary note

- **spawn** = the act exposed by the tool and emitted events.
- **child run** = the supervised execution (`ChildRunCoordinator`, child-run registry).
- **subagent thread** = the thread kind and creation seam (`SubagentThreadFactory`).

These are one concept-cluster with three facets; use each name only for its
facet.

## Cost, billing, and permissions

- Tool policy is per-turn: `projectToolPolicy` → permission gate (`check` name,
  then command) → `persistToolRejection`. A missing, non-string, or unknown
  command is `invalid_arguments`; a recognized but disabled command or tool is
  `permission_denied`. Dispatch does not apply policy. Direct
  `toolExecutor.executeTool` does not apply policy.
- The single document tool is `write` and every call requires an explicit
  `command`. Baseline `write({ command: "read", path: "..." })` reads and
  `write({ command: "diff" })` inspects the folded turn trail; these baseline
  commands do not expand URI, object, Project, owner, or document authorization.
  Diff additionally requires an owned Work draft, including the No Work row
  when draft mode is active; otherwise it returns `work_required`. Neither
  command changes Work binding or write mode.
- Model-call cost gating is not a `PermissionGate` method. The runtime uses
  `CreditLedger` plus `TreeBudget` (for spawn trees) through `turn-accounting.ts`
  and `ChildRunCoordinator`.
- `costing/` owns model token-rate resolution and applies the fixed 1.15
  `COST_MULTIPLIER` when converting raw provider USD-micro cost into metered
  millicredits before ledger debits. Billing owns only ledger behavior and route
  display conversion.
- `Usage` token counts are shared DTOs from `@meridian/contracts/runtime`.
  Because `inputTokens` is the inclusive total, pricing derives the uncached
  remainder by subtracting the cache counters, and rejects a negative result
  instead of clamping it — a clamp silently prices cached turns as free.
  Billing owns ledger behavior in `domains/billing`.

## Invariants

- **Max 32 iterations** per turn (`MAX_TURN_ITERATIONS`). Exceeding this
  finalizes the turn with an error.
- **Cancellation via `AbortSignal`** — checked before model calls, after stream
  events, and around tool execution. Cancellation finalizes the turn as
  `cancelled` and sets the thread back to `idle`.
- **Persist/project-then-emit** — every state mutation goes through
  `persistAndAppendEvents` before any event is yielded to subscribers.
  Within the transaction, `projectReadModelEvent` runs first (creating
  turn/block/model-response rows), then `eventWriter.appendEvent` appends
  to the journal (satisfying the `event_journal.turn_id` FK).
- **Tool execution** — parallel by default; registrations marked
  `sequential: true` run serially after parallel tools complete. Timeout and
  abort races are handled by the executor.
- **Provider-history completeness** — canonical history projection preserves
  persisted `tool_use` intent and synthesizes transient error results for calls
  missing results in the immediately following tool-role group. Repairs are
  never persisted and never rerun tools.
- **Edit-intent notices** — before every provider stream, the model loop drains the
  single notice port for the thread and its active documents. Notices present
  before the first call attach to that writer message and remain there for every
  tool-loop iteration. Notices recorded mid-turn are inserted after the tool
  exchange that caused them and retain that causal position on later
  iterations. This keeps the already-sent request prefix stable without
  changing the frozen system prompt or persisting notices into the turn graph.
- **Inbox adoption is lease-owned and transactional.** The current batch's exact
  IDs live in `thread_run_leases.adopted_message_ids`, never turn metadata.
  Binding a new assistant and recording its receipt commit with the graph split.
  Response persistence, inbox acknowledgement, and receipt clearing share one
  transaction. Cancellation acknowledges the receipt, not a later pending claim.
  The joined projection exposes `waiting` for an unadopted row behind a live
  bound run and `awaiting_run` for adopted rows or no bound live run.
- **Writer enqueue preserves immutable graph order.** Before persisting a writer
  turn, materialize any older queued directed messages under the same inbox lock.
  Adoption can then reuse those durable IDs without reparenting history. Rich
  reference reads and activated skill bodies are resolved at adoption.
- **Model response lifecycle** — `persistModelResponse` mints the response id
  used by tool handlers. After all tool results for that response are persisted,
  the orchestrator commits response-scoped agent-edit writes. Staged tool results
  finalize in the same database transaction as that commit using the settled
  receipts returned by agent-edit, never the speculative staged output. A
  host-only settlement id correlates each tool call to its receipt; the
  model-facing write handle is not unique within a response. A staged result
  left by a pre-commit process failure becomes a typed rejection before a later
  turn assembles model context. Durable orphan recovery recognizes that state
  only when the persisted block is marked as a staged write, its output passes
  the canonical `isAgentEditResult` guard, and the discriminated result phase is
  `staged`; a schema string alone is not sufficient. Cancellation paths roll the
  response buffer back before finalizing the turn as cancelled.
- **Response write settlement is report-only** — ordinary Yjs merge always
  commits. Destructive effects are echoed to the model and writer-lineage
  overlap may elevate receiving-writer-specific session marks. Trail evidence
  stays lifecycle-neutral and read-only.
- **Expired writer admissions** — lookup, replay, and retirement reconcile expired
  pending reservations through `UserTurnAdmission`. Recovery takes the runner's
  shared cross-process claim before the row-locking transaction and holds it
  through commit. Unexpired reservations do not contend for that claim. The
  ledger rechecks expiry and committed-turn evidence; an orphan settles to
  `recovery_no_committed_turn` without starting a model call or document effects.
- **One running turn per thread** — writer callers enter through
  `UserTurnAdmission`, whose replay lookup precedes the producer. An unseen
  identity is durably reserved, then the writer turn and inbox message commit in
  one turn-start transaction; a mid-run send merges at the run's next boundary
  instead of returning a busy conflict. `TurnRunner.startDrain` rejects a wake
  if a run is already active or being claimed for that thread. The PostgreSQL
  adapter also rejects same-process reentry because session advisory locks
  themselves are reentrant. Production runners hold the cross-process claim
  through completion delivery; a crashed process loses its session claim, so
  startup recovery can safely take over orphaned work.
- **Work context updates preserve prompt identity** — a frozen prompt is never
  rebuilt for Work changes. Business mutations enqueue immutable
  `work_context_refresh` inbox notices, including for hidden targets. Running
  request boundaries and idle recovery render current authorized state into one
  durable `<system_update>` user-role turn and `work_context.changed` event,
  then ack the selected Work notice IDs in that same transaction. These IDs are
  not response receipts. Thread visibility and turn transitions use `NO KEY UPDATE`
  so a Work mutation holding Work rows can insert its marker with FK `KEY SHARE`
  without a lock inversion. A running Work update closes A and starts B under the
  same lease so replay remains causal; ordinary request-only notices do not split.
  Writer enqueue and idle delivery use one seq-ordered prefix materializer under
  the per-thread transaction lock. Several pending mutations coalesce, while a racing
  mutation retains its own unacked row. Hidden threads/projects and archived
  threads park notices until restore; hard deletion cascades. Idle recovery
  uses `RunClaim.withExclusiveThread` without a lease or model call. In-run Work
  tools do not independently append history; the next request boundary does.
- **Registry names are global.** Duplicate registration names throw.
- **Gateway terminal outcome needs causal evidence.** The instrumented `stream.close` `outcome` is `ok`/`error`/`cancelled`. A failure becomes `cancelled` only with causal abort evidence: the thrown error is `signal.reason` or an `AbortError`. Message text alone (`"Aborted"`, `"Request aborted"`) is **not** evidence — a provider failing independently after an abort stays `error`, and `sleep`/cancel paths reject with `signal.reason` (or a synthesized `AbortError`) so their failures carry identity. A thrown error's string `.code` populates both the `stream.close` payload `errorCode` and `correlation.errorCode`.

## Cross-domain dependencies

- **Depends on `domains/threads`** — repositories, event journal, hub, and the
  subagent-thread creation seam.
- **Depends on `domains/packages`** — immutable Agent revisions and retained
  package-local named-target resolution.
- **Depends on `domains/billing` and `@meridian/contracts/spawn`** — credit ledger
  and tree budgets.
- **Depends on `domains/collab` at composition** — active-document resolution
  and response-scoped write settlement are supplied through runtime ports.
- **Consumed by `lib/` routes** — HTTP writer sends call `UserTurnAdmission`;
  cancellation still calls `turnRunner.cancel`. Composition wires both owners.
- **No direct dependency on `domains/context`** — context-using tools receive
  handlers via DI at composition time.

## Process recovery

`lib/recovery-scheduler.ts` owns only lane lifetimes. `app.ts` registers wake
scan, orphan repair, report publication, idle Work materialization, and
change-trail drain separately. Each starts at boot, rearms after completion,
and never overlaps itself. Lane failures are observed through EventSink and
cannot stall other lanes; completed passes report duration and the domain's
candidate/delivery count. Domains retain their own claims, transactions and
paging cursors. Shutdown stops timers and awaits passes for up to five seconds before draining
the Yjs gateway and flushing observability. Still-running lanes emit
`shutdown.abandoned`; their promises retain observed rejection handlers.
