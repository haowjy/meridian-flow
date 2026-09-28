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
| Retry/fallback | Exponential backoff honors provider `retry-after-ms` / `retry-after` hints (capped at 60s) and `x-should-retry: false`; its wait is abort-aware. Ordered fallback and retry happen only before **committed** output has been emitted. Committed output is visible text or a tool call; reasoning deltas and usage are process-only, so a reasoning-only abort is retryable. The gateway is the only retry layer: provider SDK clients run with `maxRetries: 0`, so one gateway attempt is one HTTP request |
| Stream timing | `attempt-stream.ts` starts one monotonic clock per adapter attempt and eagerly stamps canonical events on arrival into a byte-bounded buffer, so downstream journal writes do not distort timing. A successful result carries `timing: { latencyMs, timeToFirstTokenMs, generationMs }`: provider-attempt invocation to stream-end arrival, attempt invocation to first nonempty text/reasoning/tool-argument delta, and first output arrival to stream-end arrival. If the pump waits on the consumer, generation duration is null; latency and TTFT are retained only when their endpoint events were stamped before that wait. Both TTFT and generation duration are null when no such delta arrives; `custom.delta` is not writer output. Retry timing resets for each attempt, and the successful attempt's values are persisted. |
| Deadline | per attempt, two timers on one derived `AbortSignal`: an inactivity (stall) timer re-armed by every stream event (`GatewayConfig.attemptStallMs`, env `MODEL_CALL_STALL_MS`, default 60s; never kills a slow-but-streaming model) and an absolute ceiling backstop (`GatewayConfig.attemptCeilingMs`, env `MODEL_CALL_TIMEOUT_MS`, default 15 min / 900s, 0 disables). Per-model `stallTimeoutMs`/`ceilingTimeoutMs` override the gateway values. Retry/deadline driver lives in `attempt-stream.ts`; the signal lives in `deadline.ts` |
| Cancel drain | After partial output, a parent cancel may drain usage/end events, but one absolute five-second deadline from abort bounds that drain even after a rejected read. `attempt-stream.ts` owns one abort listener per attempt and clears its timer/listener on exit; iterator `return()` is observed without awaiting it, so a hostile adapter cannot hold cancellation or retry hostage. |
| Config | `GatewayConfig` with provider list, default model, retry/fallback/`attemptStallMs`/`attemptCeilingMs` policy; `createGatewayFromEnv` for env-driven setup |
| Registry | `MODEL_REGISTRY` in `config/registry.ts` — single-source for config + pinned pricing. `buildFromRegistry` composes providers. Flat `MODEL_TOKEN_RATES` table is **deleted**. |
| Collision warning | `onWarning` callback on registry construction warns on duplicate model IDs (was last-writer-wins silently). |
| Usage normalization | Adapters own the conversion into canonical `Usage` and call `assertValidUsage` before returning. Providers disagree on what `inputTokens` counts: OpenAI reports an inclusive total, Anthropic reports uncached input and each cache counter as separate additive categories. An adapter that passes additive counters through unchanged underbills every cached turn — see issue [#356](https://github.com/haowjy/meridian-flow/issues/356). |
| OpenRouter | `openrouter` adapter reuses the OpenAI-compatible wire shape and owns provider-reported cost enrichment via `/generation`. |
| Cancel settlement | `Gateway.settleCancelledResult()` owns interrupted-call reconciliation and persist decisions. Generic token/missing-usage handling lives in `gateway/domain/cancel-settlement.ts`; OpenRouter-specific `/generation` settlement lives under `gateway/adapters/openrouter/`. The loop only asks the gateway to settle and then finalizes cancellation. |
| Tool-arg JSON repair | `gateway/helpers/parse-tool-arguments.ts` repairs malformed provider JSON (e.g. unquoted hex hash `"in": 6c4a`) via `jsonrepair` before falling back to a typed `ToolArgsParseError` sentinel. Unrepairable input surfaces a clear model-actionable parse error instead of degrading into misleading downstream schema errors. See issue [#113](https://github.com/haowjy/meridian-flow/issues/113). |
| Instrumentation | `instrumented-gateway.ts` decorates the `Gateway` port once in `createProductionAppPorts` (`lib/compose.ts`), emitting `gateway`-source lifecycle events (`stream.open`/`retry`/`close`; per-chunk only under `OBS_VERBOSE=gateway.chunks`, dev/test-only) keyed by `correlation.gatewayCallId`. Close logs distinguish `gatewayObservationDurationMs` (includes downstream consumption) from provider timing carried by the attempt result. Provider SDK retries are disabled; `attempt-stream.ts` owns retry policy. A `Gateway` constructed outside that seam bypasses lifecycle instrumentation — intentional for tests, wrong for production consumers. Verbosity is resolved from the injected environment at that seam (`resolveObsVerbose({ rawNodeEnv, obsVerbose })` in `lib/compose.ts`), not a module-level `process.env` read — tests inject `OBS_VERBOSE`; a module-level const would bypass them. |
| Model-request inspection | Immediately before `Gateway.stream()`, the orchestrator offers the provider-neutral `GenerateRequest` to a capture port. Disabled capture does not serialize it. Local dev/test capture shares `gatewayCallId` with lifecycle events and retains at most 200 records, 2 MiB per request, and 16 MiB total; exact-call reads include the preceding request for prefix comparison. The shared `APP_DEBUG` gate can enable capture outside production, and content never enters `EventSink`, thread snapshots, the event journal, or JSONL. |
| Prefix cache state | `loop/prefix-cache-state.ts` exports pure `derivePrefixCacheState` and `createPrefixCacheStateService`. The service's `prefixCacheStateFor({ threadId, model, now })` gathers the latest response through `findLatestByThread`; model and descriptor come from the context assembly's resolved registry model. Predictions are recorded on `model_responses` in the same transaction as usage. Warmth follows the shared `threads/domain/prompt-epochs.ts` `bakeIdAt` rule, complete compaction boundaries, and the `system_update`/`image_inclusion` codec; first-sight image notices append without breaking the sent prefix. Forks resolve their cutoff owner's history and bake before first local response. Cache age is anchored on the previous response's `model_responses.request_started_at`, the successful gateway attempt's wall-clock invocation time, not persistence time or latency subtraction. Missing start is `cold/facts_unavailable`. The recorded prediction is made before `Gateway.stream()`; it is not recomputed after retry waits. |
| Prompt cache intent | `ContentPart.cacheBreakpoint?: true` is provider-neutral intent, not provider syntax. The loop sets up to three marks only for a registry model with `promptCache.kind === "explicit"`. `GenerateRequest.promptCacheKey` is an unconditional routing hint: ordinary threads use their own ID, forks use the ID of the thread that owns their cutoff turn. Adapter wire shapes, TTLs, and the model descriptor live in [gateway context](../gateway/.context/CONTEXT.md). |

Canonical gateway types live in `gateway/domain/types.ts`.

## loop — orchestrator + run sessions

One run = one lease through potentially many LLM-call + tool-execution
iterations and assistant turns. The loop is intentionally decomposed; `orchestrator.ts` owns the
skeleton and delegates the moving parts.

| File | Role |
|---|---|
| `orchestrator.ts` | Builds run-start and next-boundary model context from selected writer messages, durable history, references, skills, and images. It returns durable turn events plus the assistant to reserve; the delivery boundary owns preparation retries, notice consumption, inbox adoption, and atomic commit. `loadRunStartContext` reports a typed fork-history load failure as the `thread.conversation_context.load_failed` warn event and preserves the `thread_context_error` failed-reply path instead of falling back. A mid-run adoption completes assistant A and creates B, preserving graph order. Report admission belongs to the first commit that adopts a directed row, on that commit's reserved turn. Control-only runs admit no report. |
| `inbox-context.ts` | Materializes a selected batch as durable turns/blocks. Caller-supplied notices and notice-intent inbox entries fold into one trailing `{ kind: "system_update", section: "notices" }` system turn built by `noticesTurnFor`/`formatNotices`; Work refreshes render to their own durable turn. Existing writer turns are adopted without a second append. `prepareAdoptedTurn` prepares missing text-reference reads and activated skill bodies, returning events and hidden sibling turns for the adoption transition -- never a block on the adopted turn itself, since anything that projects a user turn's text (`UserTurn.tsx`) concatenates every text block on it. `planMessageTurns` and `messageTurnFor` own fresh message history. Child completions persist a system turn with `{ kind: "subagent_update", handle, outcome, execution }` metadata; the execution UUID is for internal card correlation only. The shared context assembler renders from `turns`/`blocks` alone; never splice a second inbox rendering over the assembled request, which bypasses image authorization, model capability, and the whole-request occurrence budget. |
| `runtime-delivery.ts` / `adapters/runtime-delivery.ts` | One `prepareAndCommit` protocol serves drain start and mid-run adoption. Direct run input first persists the writer turn and matching inbox message under the thread lock, then uses the drain-start path. The protocol selects pending IDs, peeks notices, and reads the active leaf without the lock; prepares image decisions, references, skills, and turn drafts without writes; then takes the thread lock and validates the leaf and pending batch. A changed selection is discarded and retried for at most three attempts; attempt three prepares under the lock. One ambient transaction consumes exactly the selected notice IDs, persists the first prompt bake and preparation effects, adopts the batch, and reserves/binds the assistant. Preparation failure leaves notices queued but adopts the writer batch and reserves the failed reply; the existing failure finalizer acknowledges that batch. Cancellation discards preparation. Notice IDs enter durable `system_update` history at the selected graph point, so prefix bytes remain stable. Image decisions are append-only by deciding turn; when a projection emits a break, its notice turn owns those decisions and `turn.created` precedes them. A fork copies the latest decision at or before its cutoff. Final close prepares only for pending messages or materializable Work refreshes; after a successful run's cleanup, any late pending message starts another run. The concrete Drizzle adapter appends the classified pending replacement before commit; journal failure rolls back the transition and only physical wake is best-effort after commit. |
| `run-starter.ts` / `sweep-wakes.ts` | The wake actuation seam. `createRunStarter` maps `RunStarter.start` to the turn runner's `startDrain`, handling `TurnStartConflictError` quietly and reporting unexpected failures once through EventSink because a wake is best-effort. `sweepWakes` is the durable recovery: it keyset-pages pending threads in stable thread-ID order, batch-reads live leases, and starts eligible threads with bounded concurrency. Its caller retains the returned cursor across sweeps; an empty suffix wraps to the first page. One candidate’s failure is reported without stranding the rest. `app.ts` registers the sweep with the process recovery scheduler at boot, then rearms it after completion with `WAKE_SWEEP_INTERVAL_MS` (default 30s). The `enqueue` wake is the latency path; the sweep is the guarantee. |
| `thread-lock.ts` | Short per-thread transaction serialization, distinct from the session run claim. Delivery acquires the advisory lock, then the shared `NO KEY UPDATE` thread row lock before enqueue or consumption/close. Work rows follow the thread row in sorted id order through `shared/thread-work-lock.ts`; publication parent locking and writer admission use the same order. Work-only notice insertion takes no thread mutation/advisory lock, only compatible FK `KEY SHARE`. No provider call runs under these locks. |
| `block-helpers.ts` | Content block conversion and local accumulator helpers. |
| `turn-accounting.ts` / `settle-summary-responses.ts` | One `computeAndDebit` path records summary-call cost against the shared tree budget and credits ledger in the transaction that completes, fails, or cancels C. Summary calls do not spend model iterations or the turn budget; the successor's next pre-iteration check sees any exhausted tree cost budget. |
| `interrupt-session.ts` | Same-turn interrupt suspend/resume mechanics and component-block updates. |
| `tool-dispatch.ts` | Live output, spawn/thread_message/returnResult callback wiring, and durable tool_result persistence. Dispatch does not apply policy. return_result settlement is spawn-owned: dispatch honors the typed `ReturnResultOutcome` and does not parse arguments or reconstruct the envelope from JSON. |
| `run-turn-port.ts` | `prepare(input)` returns a `PreparedRun` with run/initial assistant identity, pre-setup replay cursor, post-setup snapshot floor, and one-shot `execute(): Promise<RunOutcome>`. Setup commits before returning; only execute enters the model loop. The journal/hub is the sole event consumer, not an orchestrator generator. |
| `run-session.ts` | One owner for writer and child claims, AbortController, current-turn registry, heartbeat, cancel, terminal fallback, and best-effort release. `execute` settles after cleanup; child report publication B follows it. A primary completion aborts foreground descendants only; a child invocation bounds its whole subtree and aborts background descendants too. Explicit cancellation includes background descendants. |
| `orphaned-placeholder.ts` | `finalizeOrphanedPlaceholder` uses the pure `@meridian/contracts/threads` placeholder predicate and targeted per-thread query under the thread lock and an already-held session claim. Writer-facing interrupted copy comes from `threads/domain/turn-metadata.ts`, from its trigger metadata. The helper returns reports it finalizes, and callers publish them only after releasing the child lock. |
| `interrupts.ts` | `InterruptRegistry` factory; process-local pending interrupt promises plus restart recovery from the event journal. No module-global registry state. |
| `context-builder.ts` | Builds `Message[]` + `Tool[]`; receives the frozen system prompt from the immutable bake row when the thread has an initial pointer; renders every persisted turn, including durable notices, skill-body, and subagent-update turns. Child-provenance system text contains a compact exact `thread_report` call, never the report body; the parent model may fetch that report with the authorized tool. Assistant custom blocks stay UI-only to preserve tool_use→tool_result adjacency. |
| `compaction/{trigger,estimate,plan,project,tail}.ts` | Pure C4a core. `trigger.ts` resolves explicit Agent limits; `estimate.ts` owns the shared per-part estimator for planner defaults and request estimates. Every estimate receives the model registry's required tokenizer family, including turn planning and summary segmentation. CJK family rates and evidence are recorded in [CJK estimator rates](#cjk-estimator-rates). Image parts use 1,600 tokens, and file text uses the greater of its visible-string estimate or the 10,000-token floor. `plan.ts` takes the raw effective transcript, reserves overhead and all unanswered directed requests plus the newest writer request, and limits later cuts to after the active compaction cut. A missing pinned request yields an explicit `no_compaction` plan, never persistable metadata; `tail.ts` is the shared ordered projection rule, lifting pins in order when the cut removes them; `project.ts` strictly decodes complete compactions, requires every pinned turn to exist, and projects the summary under the owning thread ref. The folder's `index.ts` is the runtime public surface. History-item metadata classification and its codecs live in `threads/domain/turn-metadata.ts`. |
| `turn-context-assembly.ts` | Resolves the retained Agent and bake, then projects active compaction history with `thread.ref` before stable image inclusion and `buildContext`; this keeps old pre-cut images out of the rebuilt model request while leaving un-compacted requests byte-identical. |
| `composed-system-prompt.ts` | Assembles the first gateway system prompt in a fixed layer order: immutable agent body (revision body or the host-owned empty default), the invocation overlay's additive `appendSystemPrompt`, frozen Work context, available skill slugs (name when it differs) and descriptions, named subagent slug/name/description from the bound roster, core document dialect, runtime URI instruction, and, for subagent threads only, the mandatory closing report instruction as the last layer. An empty or absent append adds nothing, and the guidance string is a module constant (`SUBAGENT_GUIDANCE`). Freeze sentinel is `thread.initialPromptBakeId !== null`. The first bake commits with a successfully prepared run start before model execution; a later gateway failure or cancellation leaves it in place. |
| `work-context.ts` / delivery adapter | Renders authoritative Work state. Mutations enqueue immutable system-provenance refresh notices in the business transaction. The delivery boundary coalesces a batch into one durable system update and event and acknowledges its notice IDs atomically. Idle recovery uses a short run claim; notices never wake a model. |
| `ports.ts` / `adapters/drizzle-run-claim.ts` | `InboxReader` is read-only; `selectPending` does not claim or mutate. `RunClaim` shares one nonreentrant session advisory claim across `withExclusiveThread` (short admission/Work/recovery work without a lease) and `startExecution` (observable, heartbeating lease). Only delivery binds the current turn (assistant or pending compaction) and receipt. Receipt mutation is guarded by thread/run/holder and exact IDs when clearing; the held session claim, not heartbeat expiry, authorizes a paid response commit. Guarded `cancelExecution(threadId, turnId)` matches any selector bound to the live run under the lease row lock: a prior segment can stop its current successor, but a selector from an ended run cannot stop a new run. Session release deletes only its own lease and physically unlocks after commit; the session owner retains one failure-backstop release. |

| `system-instructions/` | Model-facing prompt assets independent of any agent body. `document-dialect.ts` owns Meridian document language and its codec-backed spelling contract; `runtime-uris.ts` owns context namespace guidance. Tool descriptions continue to own mechanics. |
| `streaming.ts` | Maps gateway `StreamEvent`s to `OrchestratorEvent` stream deltas and extracts tool calls. |
| `partial-tool-activity.ts` | Reads only the top-level string fields used by live labels from partial tool-call JSON; it tolerates an unfinished object and ignores nested arguments. |
| `execution-finalizer.ts` | Terminal transaction projects the current turn event and finalizes the nearest admitted report on the terminal turn's ancestor chain. The report's selector remains its admitted first reserved turn; `terminalTurnId` records the final turn. A pending placeholder can end failed or cancelled, never successful through this finalizer. Fallback text is from that terminal turn’s final persisted response; cost includes terminal responses and every assistant or compaction response back through the selector, so a C that is the selector or terminal is covered once. Run-scoped capture keeps the existing partial-outcome policy except orphaned placeholders, whose child report is empty. Intermediate splits never publish a report. |
| `persistence.ts` | Transactional persist/project-then-emit helper. **Ordering**: `projectReadModelEvent` runs before `eventWriter.appendEvent` so the `event_journal.turn_id` FK can reference the turn row created by the projector. Both happen in the same repo transaction. |
| `admission/` | `UserTurnAdmission` owns writer replay, canonical fingerprinting, exact ordered text/reference/image parsing, project-final authorization with in-place text degradation for unavailable reference identity, lookup, and retirement. Admission is **validate → record → enqueue**: `admission/writer-turn-producer.ts` is the producer. It persists the writer's user turn + blocks at enqueue (reusing the inbox message id as the turn id), stamping any activated `/skill` slugs as hidden turn metadata for `prepareAdoptedTurn` to load when the turn is adopted; the delivery commit persists the hidden `system`-role skill-body turn immediately after it. It also appends the writer-provenance `message` in the same turn-start transaction, settling the admission ledger, upload consumption, and document attachment atomically; the wake is best-effort. Liveness is the runner map, never durable turn status: a mid-run send yields the runner's live assistant turn id (a crash-orphaned `streaming` turn and a `waiting_interrupt` run classify correctly), a fresh run yields null and the client learns the turn from `RUN_STARTED`. When a live assistant binding exists, the writer turn gets `metadata.delivery: "steer"` at enqueue; response grouping uses that stamp, not clock comparisons. The producer reads durable rows only as a fallback inside the runner's setup window, scoped to turns created after the run started. An admission winner rolls the whole turn-start transaction back instead of committing a losing or rejected submission. `admission-turn-starter.ts` and `TurnRunner.startTurn` are gone. |
| `reference-context.ts` | Before the first model call, loads admitted current-turn text references through the host-wired shared agent-edit read operation; a mid-run adopted writer turn's unread references load at adoption. Reads run outside admission/persistence transactions; results are persisted server-side at `reference.read.result` before gateway submission. Duplicate `(documentId, uri)` identities read once per turn; replay reuses the frozen result, while a later mention reads afresh. Images retain their separate projection, and client admission rejects `read` payloads. |
| `image-context.ts` / `ports/image-asset.ts` | Late image bytes are identity-resolved after admission and read-deduplicated. `thread_image_inclusions` is append-only, keyed by `(thread_id, block_id, decision_turn_id)`; the latest row by turn position wins. A definite loss of a previously included asset creates an `asset_unavailable` break turn; a first-sight loss uses `asset_unavailable_first_sight` and does not break the already-sent prefix. Budget eviction of an included image creates its own named break. Transient resolution errors propagate to the failed-reply path without deciding the image. Projection applies the shared budget chronologically over history and adopted turns; compaction is the explicit seam for rebalance. Durable blocks retain only `image_reference` identity, never resolved bytes or inclusion state. The image-inclusion metadata codec lives with the other turn codecs in `threads/domain/turn-metadata.ts`. |
| `permissions/` | `projectToolPolicy` projects compiled Mars `tools` / `disallowed-tools` onto Flow tool names and command sets (`write`, `work`). `write` is always advertised with `read` and `diff`; existing `edit` policy adds or removes mutation commands. `advertiseTools` uses that same command set to narrow both the schema and `write` description, so denied-command instructions are not exposed. Retained historical `read` policy metadata is inert. `commandSetForTool` is the single command mapping. Advertise and the per-turn permission gate (name + command) use that policy. `invocation-authority` validates that an invocation patch never grants the child more than the caller holds, applied only to the patch delta. Dispatch does not apply policy. The core catalogue stays policy-free. |

`OrchestratorDeps` is fully required: gateway, repos, retained Agent revision reader, tool
registry/executor, project preferences, credit ledger, the `RuntimeDelivery` boundary, the `RunClaim`, interrupt artifact flush, child-run coordinator, interrupt
registry, and
`EventSink` are all explicit dependencies. Do not re-add a global permission
gate here; names and per-tool command sets are gated per turn from advertised policy. Provider-specific
model-call behavior stays behind the gateway port. Disabled behavior is
represented by explicit adapters (for example no-op sinks), not by omitted deps.

## Inbox delivery: worked examples

What the model actually receives for five common deliveries, so "durable
`system_update` turn" and "merged into one message" stay concrete:

1. **Writer steer mid-run, after a tool call.** The writer sends "also tighten
   the dialogue" while a tool call is in flight. `drainInbox` persists it as an
   ordinary `user`-role turn chained onto the thread; `context-builder.ts`
   renders the preceding response's `tool_result` as a canonical `role: "tool"`
   message and the steer as a canonical `role: "user"` message, back to back.
   The Anthropic adapter maps `tool` to `user` (Anthropic requires tool results
   in a user turn) and then merges consecutive same-role messages, so the two
   arrive as one Anthropic `user` message: the `tool_result` block immediately
   followed by the text block `"also tighten the dialogue"`.
2. **Background subagent completion.** `spawn/report-publisher.ts` enqueues a
   child-provenance `message`; `messageTurnFor` persists it as a `system`-role
   turn (`{ kind: "subagent_update", handle, outcome, execution,
   childThreadId, agentName }`) whose block
   text, once wrapped by the render path, is exactly:
   ```
   <system_update>
   Subagent p1 finished (succeeded). Read its report with thread_report({"ref":"p1"}).
   </system_update>
   ```
   The report body never appears; the parent model fetches it with the
   authorized `thread_report` tool call named in the text.
3. **Work switch.** A Work mutation enqueues a `work_context_refresh` notice;
   `adopt()` renders the current authorized state and `messageTurnFor` persists
   it as a `user`-role turn (`{ kind: "system_update", section: "work_context"
   }`) whose block text is:
   ```
   <system_update>
   <work_context>
   current: drafting: "Drafting" (goal: land the reveal in ch. 12)
   active (most recent first; max 5):
     none
   </work_context>
   </system_update>
   ```
4. **A request-only notice.** An `awareness_degraded` notice recorded through
   `NoticePort.record` is selected by a delivery-boundary peek; commit consumes
   its ID and `noticesTurnFor` persists it as a `system`-role turn (`{ kind:
   "system_update", section: "notices" }`) whose block text is:
   ```
   <system_update>
   The system could not verify whether concurrent writer content was preserved in chapter-12.md. Re-read the document before making another write.
   </system_update>
   ```
5. **A `/skill` activation.** A writer send stamps its activated slugs as
   hidden turn metadata at admission. `prepareAdoptedTurn` loads each body, and
   the delivery commit persists a `system`-role turn (`SKILL_BODY_METADATA`,
   i.e. `{ kind: "system_update", section: "skill_body" }`) chained
   immediately after it -- never a block on the writer's own turn, so
   `UserTurn.tsx`'s `projectUserTurn` (which concatenates every text block of
   a user turn) never renders it. Its block text is:
   ```
   <system_update>
   skill invoked: writing-principles

   description: Craft rules for revision

   Show, do not tell.
   </system_update>
   ```

Every one of these five is either a `system`-role turn with no custom block
(2, 4, 5) or a `user`-role turn carrying one of the specific hidden-metadata
shapes above (1 is genuinely visible; 3 is not). `visible-conversation-policy.ts`
and the app's `visible-chat-turns.ts` keep every hidden one out of the chat
transcript with no UI change: a `system`-role turn is visible only if it is
not `subagent_update` **and** carries a custom block (never true for 2, 4, or
5), and a `user`-role turn is hidden only for `inbox_message` or
`system_update`/`work_context` (true for 3, false for the writer's own turns
in 1 and 5).

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
Prompt lifetime: the system and advertised-tool bytes come from an immutable
`prompt_bakes` row. First assembly inserts a bake and wins the thread's
write-once `initialPromptBakeId`; concurrent first attempts use the row lock
and all receive the winner. `turn-context-assembly.ts` loads the bake by that
pointer and passes its system bytes to `buildContext`. Work, notices, child
results, and invoked skills enter as durable in-place conversation turns,
never a live-request-only splice: `prepareAdoptedTurn` prepares an invoked
skill's body and the delivery commit persists it once onto its own hidden
`system`-role turn chained right after its activating turn. A Work refresh is
its own durable `user`-role `system_update` turn, and every other notice is its
own durable `system`-role `system_update` turn (`inbox-context.ts`). Forks keep
the source's bound Agent and inherit `bakeAt` the cutoff on the owning thread;
a fork cannot select a different Agent. Only a handoff can change the Agent,
and a different-Agent handoff starts unbaked.

**A thread's cached request prefix — system prompt, advertised tools, and
history — is fixed except at named prompt-epoch boundaries and image-removal
breaks.**
`agent-thread-context.ts` still re-derives `advertiseTools(baseTools, policy)`
(+ the spawn description and, for a subagent thread, `return_result`) every
turn, but once `isThreadPromptFrozen(thread)` the assembler reads
`PromptBake.bakedTools` and `PromptBake.composedSystemPrompt` verbatim. Live
`policy` (from the immutable thread
binding) still gates execution every turn — freezing only pins what the model
is *told* it can call, never what dispatch and the permission gate actually
allow. If a frozen advertised tool no longer exists in the live registry,
`ToolExecutor.executeTool` already returns an ordinary `Tool not found`
tool-result error (`tools/tool-executor.ts`) rather than crashing — dispatch
was always by name against the live registry, never against the advertised
list. A code deploy, Agent revision update, model change, or idle/cache-TTL
timer never rebakes a live thread. `beginPromptEpoch` is the named transactional
operation for a reserved boundary: it hashes composed live parts, reuses the
current row when bytes match, and completes the turn through
`persistAndAppendEvents`. It has no production caller until C4. `bakeAt` and
`bakeInEffect` use complete owner-local boundary turns in write-once
`turns.position` order. Turn positions are assigned under the existing thread
mutation lock, and fork-local turns begin after their cutoff. When the model
needs to learn about a change mid-thread, that is a system notification folded
into conversation (the existing inbox/notice path in `work-context.ts` and the
loop's notice port), never a tool-list or prompt change.

Prompt bake
and the `skill` tool use bound Agent `skills.available` only (name and
description from retained `SKILL.md`), dropping `model-invocable: false`.
Account installs never join the prompt or `skill()`. `skills.load` is not
injected into first-turn context; nonempty `load` refuses selection. Writer's
load list is empty. The first-bake CAS persists those Agent-available slugs
(`[]` when the Agent list is empty). Later turns send `composedSystemPrompt`
verbatim from the referenced bake. Skills that join slash after freeze do not
rewrite the prompt or its skill list. Display slugs do not guard prompt
freezing. The model comes from conversation-owned resolved
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
| Spawn tools | `tools/spawn-tools.ts` registers `spawn`, `thread_message`, and `return_result` with explicit privileged capabilities. `thread_message` `{ ref, message, mode }` puts a message into a thread (default `mode: background`); foreground targets a subagent in the caller's subtree and returns its report. `return_result` accepts Meridian document URI strings and validates them through the contracts capture schema before mapping them to `{ type: "object", uri }`. Invalid input returns a model-correctable tool error instead of aborting the child run. Neither spawn nor thread_message accepts an escalation patch. |

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
A writer send is never an inbox delivery: `writer-enqueue.ts` persists the
writer's user turn with its own metadata (activated skill slugs or null) and no
`kind`, so it stays a visible bubble before and after adoption. Only machine
deliveries (an agent `thread_message`, other non-child messages) materialize
with `kind: "inbox_message"`, which hides them from the bubble list; the client
renders them as delivery rows inside the preceding assistant turn. Tagging a
writer turn `inbox_message` makes the writer's own message vanish once a run
drains it.
`spawn/orphan-report-repair.ts` pages pending placeholder turns through the
`turns_pending_placeholders` partial index and uses the same targeted per-thread
query as run start for its under-lock re-read. `@meridian/contracts/threads`
owns the role set and pure TypeScript predicates; the database package owns the
SQL predicate beside the partial index, and `threads/domain/turn-metadata.ts`
owns role/metadata-specific interrupted copy through the compaction codec. Both repairs require the real session claim and thread lock; expired
lease rows are not proof of death. It finalizes pending placeholders before
walking the child chain and treats any admitted execution selector as a walk
barrier, including compaction selectors. Placeholder finalizers return child
reports for publication after releasing the child lock. The process scheduler
runs wake, repair, and publication lanes independently. The coordinator consumes `RunTurnPort` through its driver,
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
`agent.run_completed` metadata; there is no spawn-named completion event. Create and terminal also append a neutral `subagent.activity` fact to the child's
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

Step 2 exposes `thread_report({ ref, run? })` as an ordinary advertised tool
(`spawn/read-thread-report.ts`). `ref` is the `pN`/`cN` thread-ref grammar
(`thread-ref.ts`); an omitted `run` defaults to the child's latest finished
report, and an explicit 1-based `run` reads an earlier one. Authorization is
same project and same spawn root (`sameLineage`) plus caller ownership, all in
one root repeatable-read snapshot. A `run` with no matching finished report, or
one whose outcome/source/summary never finalized, is `unavailable` -- the only
non-success status this tool returns. (The separate writer-facing
`GET .../reports/[childThreadId]/[execution]` route additionally returns
`not_ready` for an execution that has not finished yet; it resolves `execution`
to a `run` index itself and is not the model-facing tool.) `ChildDriveInput.reportCorrelation`
carries only the caller/turn/tool/card and origin/delivery metadata; the actual
child `executionTurnId` is assigned only after turn admission. The runtime
admits each child run once, finalizes its saved report with the terminal
turn, and publishes a parent card/notification from that durable
row. Tool and API responses share the `ThreadReportResult` contracts schema,
including `childThreadId`; the app projects both through `toReportContentValue`.
Generic `ThreadPendingInbox` projects every provenance; the app's
`queuedWriterTurnIds` (`pending-inbox.ts`) is the client-side selector that
keeps writer-provenance rows in `waiting` so only those bubbles show Queued.

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
- `ask_user` is never advertised until its rework (composer-attached answer
  input and defined subagent semantics,
  [#601](https://github.com/haowjy/meridian-flow/issues/601)), even when an
  Agent's Mars policy allows it (`project-tool-policy.ts`). The interrupt
  runtime and the app's interrupt card remain; re-enabling is that one line.
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
- **Edit-intent notices** — are projected as durable `system_update`/`notices`
  turns at the adoption point. See the `runtime-delivery.ts` protocol above for
  selection, failure, and transaction semantics.
- **Inbox adoption is lease-owned and transactional.** The current batch's exact
  IDs live in `thread_run_leases.adopted_message_ids`, never turn metadata.
  Binding a new assistant and recording its receipt commit with the graph split.
  Response persistence, inbox acknowledgement, and receipt clearing share one
  transaction. Cancellation acknowledges the receipt, not a later pending claim.
  The joined projection exposes `waiting` for an unadopted row behind a live
  bound run and `awaiting_run` for adopted rows or no bound live run.
- **Writer enqueue preserves immutable graph order.** Before persisting a writer
  turn, materialize any older queued directed messages under the same inbox lock.
  Adoption can then reuse those durable IDs without reparenting history. The
  prepare/commit protocol above owns context preparation and failure handling.
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
  same lease so replay remains causal; every other durable notice source (`NoticePort`,
  non-message inbox entries) splits the same way, folded into one trailing
  `system_update`/`notices` turn by the same `adopt()` transition. No notice
  source skips this split.
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

## CJK estimator rates

Each registry model carries a required tokenizer family (`anthropic`, `o200k`,
`gemini`, or `deepseek`). The estimator requires the request model's family;
there is no fallback family.

| Tokenizer family | Rate (tokens / CJK code point) | Basis |
|---|---:|---|
| `anthropic` | 3.0 | Conservative placeholder above a small published ~2.3 sample (range to 2.5); not measured locally. [Carwash methodology](https://carwashtest.org/methodology.html), [Anthropic token-counting guidance](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/token-counting.md). |
| `o200k` | 1.1 | Offline `tiktoken` `o200k_base` count of the committed CJK corpus: 1,827 tokens / 1,882 Han points = 0.9708; add 10% headroom and round up to a tenth. Published sample is ~1.0; encoding mapping: [OpenAI `tiktoken` model map](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py), [Carwash methodology](https://carwashtest.org/methodology.html). |
| `gemini` | 1.2 | Low-confidence placeholder over a published ~0.8 sample; Google’s general character heuristic is not Chinese-specific. [Google token guide](https://ai.google.dev/gemini-api/docs/tokens), [Carwash methodology](https://carwashtest.org/methodology.html). |
| `deepseek` | 0.8 | C4e live V4 Flash corpus measured 0.69 with headroom; near DeepSeek’s published ~0.6 general guidance. [DeepSeek token usage](https://api-docs.deepseek.com/quick_start/token_usage/). |

Refresh rates with `pnpm --filter @meridian/server exec tsx
scripts/probe-compaction-estimates.ts`. The probe reports each reachable
provider against its declared family and a per-family recommendation with 10%
headroom, using `apps/server/scripts/fixtures/compaction-estimator-probe.json`.

## Compaction request boundaries

`loop/request-preparation.ts` measures the assembled request and plans against raw
history. The token baseline comes from the cache service's reusable-prefix
selection with TTL ignored; missing/zero usage estimates the whole request.
Without an explicit Agent limit, the trigger is floor(90% × min(input pricing
tier ?? usable window, usable window)), capped at 400,000 tokens. Explicit Agent
token and percentage limits are not scaled. Mars defines no off switch.

| Models | Default trigger tokens |
|---|---:|
| Sonnet 4 (direct and OpenRouter) | 165,254 |
| Sonnet 4.6, GPT-4.1, GPT-4.1 mini, Gemini 2.5 Flash, DeepSeek V4 Flash | 400,000 |
| Haiku 4.5 | 122,400 |
| Haiku 3.5 | 172,627 |
| GPT-4o (direct and OpenRouter), GPT-4o mini | 100,454 |

`summary/conversation-summarizer.ts` implements the port in production. Warm
sends the request in hand with an appended system-origin instruction and a lower
output cap (summary reserve plus thinking budget), never increases its cap or
changes its other fields. Any unusable warm response or provider failure runs
cold once; Stop does not. Both attempts return their rows for settlement.
Cold uses `COMPACTION_SUMMARIZER_MODEL` (default DeepSeek Flash), or the retained
thread model when that provider is disabled. Its prediction is always
`cold/summary_transcript`, not the thread prefix's prediction.

Cold receives only the cut blocks and prior summary, excluding the retained pin
and tail. It renders model-visible custom content, omits opaque reasoning and
thinking, and labels prior context. Before any cold call, all turns are measured.
Oversized turns replace re-readable tool bodies with a URI and short excerpt,
then split at block boundaries if needed. An oversized indivisible block fails
before any cold call. Rolling segments carry the running summary forward and
reserve its provider-token output cap independently of the CJK request estimator,
then recheck each assembled request against the usable window. Prompts preserve exact
story terminology, quoted writer wording and per-document done/pending edits;
they forbid invented facts.

Output-limit failure uses the provider finish reason, not an input-token estimate;
the successor fit check still measures the full assembled request.
Every attempted call returns its row, prediction and message count, even when a
later segment fails or Stop aborts it. Settlement records path/segment metadata
and charges those rows only in the transaction ending C.

The gateway normalizes provider context-window failures to `context_overflow`.
The loop completes A at its last persisted tool group (empty is legal), then
prepares a forced `compact` decision with a cold path and an independent usable
window fit limit from the resolved usable window. It retries generation once per
reply (not once per tool iteration); a split adopting new input renews that
budget, while the compaction successor preserves it. A second overflow fails with
`context_window_exceeded` and acknowledges the receipt rather than re-sweeping
the same request. Metered output from an overflow is billed without retaining
the incomplete response's blocks. The WebSocket live-state codec accepts
`compacting` so a client can join while C is pending.

Compaction is two delivery transitions around an unlocked `ConversationSummarizer`
call. The first reserves pending C instead of an assistant. `compaction-phase.ts`
then prepares a live rebake over provisional completed C before late arrivals.
compaction-successor.ts returns one retry-local usable/failed value; the delivery
adoption carries that value into its explicit placeholder completion mode. The
complete summary block is immutable, and its fit limit comes from the decision,
independently of the automatic trigger. A usable value's token count describes
the compacted base before late arrivals. Its successor commit joins `beginPromptEpoch`, adoption, notice consumption and B's
reservation. A moved leaf repeats only successor preparation, never summarization.
An automatic compaction with an impossible tail reserves no C. A failed required summary errors C and replies below the
latest message; an optional manual summary fails only C. A live unexpected error while C is current uses a fresh failure
transaction: C error, settled summary rows, failed B below the latest arrivals,
and receipt acknowledgment. Notices remain queued. If that transaction also
fails, orphan recovery owns C; this run makes no further settlement attempt.
Paid rows still in memory are uncommitted and cannot be recovered by the orphan
finalizer, exactly as at a process crash. They are not debited; a later delivery
may need another provider call. A usable epoch still commits when a late arrival fails context
preparation (including an oversized late paste); only B fails. `composeLivePromptBake` serves initial bakes and rebakes
alike. Reference reads during this prepare belong to current C; B does not exist
until commit. Summary responses never supply the conversation token baseline.

The lease does not copy current-turn kind; currentTurnKind(turn) derives
assistant or compaction from the referenced turn's role. Both reservation sites use
reservationTurn, including the decision's trigger. The lease retains bound_turn_ids for this live run, appended in the same
transaction as each current-turn binding. Stop matches this membership under
the lease update lock, whether it names a predecessor or the newly committed
successor and whether it reaches the owning process or a remote process.
Membership resets with the next run, so a finished run cannot cancel a newer
lease. The process-local session does not keep a second membership map. Writer admission returns an assistant ID only for the former. Stop
aborts the summary, and terminal close settles its response rows on cancelled C
with the receipt acknowledgment. settleSummaryResponses writes predictions,
request sizes and debits through TurnAccounting.computeAndDebit inside whichever
transaction ends C. Retrying settlement does not count the paid call twice in
the shared tree budget. Late arrivals are not part of C's receipt and
remain queued for the cancel wake. Remote cancellation reaches the local signal
through the lease heartbeat as well as boundary checks. Only the run signal or
durable cancel request authorizes cancellation: a returned cancelled summary
on a live signal is failed, and an internal AbortError alone is not Stop.
Summarizer adapters return every attempted paid response in their outcome and
never throw after a paid call; unexpected throws are error-level events.

Run start finalizes stale pending placeholders before selection using the new
run's own held claim. The orphan-repair lane also scans indexed pending
placeholders, so quiet primary threads recover without a new wake; child reports
are finalized on C and published after releasing the child's lock. A late writer
message stays unacknowledged and is redelivered rather than receiving a synthetic
failed reply. Compaction responses count when the compaction is the orphaned
execution's terminal turn; accounting completed compaction ancestors remains C4e.

## Control boundaries

`planControlBarrier` selects the raw inbox before Work coalescing and ack-id
calculation. A head control waits for unbound directed rows ahead unless a
chained row lies behind it; then every chained row and the inbox-only prefix
are adopted before C. Notices alone never delay K. Controls never enter
`drainInbox` or `planMessageTurns`. The first request after reservation uses its
already-prepared context, not another control boundary.

Writer enqueue keeps writer turns visible immediately. Its prefix materializer
uses the barrier but never reserves a control. Idle materialization holds a
claim, finalizes orphan placeholders first, and then uses the same selection.
A normal assistant close defers an executable control to the post-release wake;
a tool boundary executes it inline. Both durable wake sweeps include controls.
Cleanup wakes only when the raw pending barrier can execute a control now,
with no bound/chained exemptions from the released run. A directed row ahead
of K follows the ordinary message restart rule; failed replies and failures
before reservation retry through the sweep, not a hot post-release loop.

Manual decisions fit against the usable window; their tail budget base is
`min(trigger, tokensBefore)`. Automatic and overflow decisions use their fit
limit as the tail budget base. Pins include the existing unacknowledged receipt
and newly adopted directed rows, even across consecutive controls. A refusal
records an error divider without calling the summarizer or opening an epoch.
A manual control immediately after completed C refuses with `nothing_to_compact`;
C's retained tail is not new history.

A control's ending commit acknowledges its row, then reserves/binds the next
due control, reserves B for an outstanding message or ongoing task, or releases
the lease atomically. A control-only idle compaction creates no B. A failed
optional manual summary continues the ordinary request. Stop on a manual C acknowledges controls only, leaving unanswered messages for the
owner's post-release wake; ordinary autocompaction Stop retains its old receipt
semantics. A crash leaves K pending for redelivery after orphan finalization.

`thread-controls.ts` owns writer enqueue and withdrawal, separately from the
message producer port. Client ids remain taken after execution or withdrawal.
The thread lock serializes withdrawal with reservation. A manual control bound
as `controlMessageId` becomes Stop. An absorbed `satisfiesControlId` returns
`already_finished`: the automatic C still retires it and answers its messages.
`absorbPendingCompact` owns satisfaction selection for initial and mid-run
reservation. Control enqueue finds the latest matching turn by control id,
not by loading the transcript. See [HTTP contracts](../../../../../../docs/api/thread-controls.md).
