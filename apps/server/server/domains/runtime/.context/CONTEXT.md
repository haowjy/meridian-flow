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
| Retry/fallback | exponential back-off and optional ordered fallback only before output has been emitted |
| Deadline | per-attempt wall-clock timeout (`GatewayConfig.attemptTimeoutMs`, env `MODEL_CALL_TIMEOUT_MS`, default 120s), enforced with a derived `AbortSignal` |
| Config | `GatewayConfig` with provider list, default model, retry/fallback/`attemptTimeoutMs` policy; `createGatewayFromEnv` for env-driven setup |
| Registry | `MODEL_REGISTRY` in `config/registry.ts` — single-source for config + pinned pricing. `buildFromRegistry` composes providers. Flat `MODEL_TOKEN_RATES` table is **deleted**. |
| Collision warning | `onWarning` callback on registry construction warns on duplicate model IDs (was last-writer-wins silently). |
| Usage normalization | Adapters own the conversion into canonical `Usage` and call `assertValidUsage` before returning. Providers disagree on what `inputTokens` counts: OpenAI reports an inclusive total, Anthropic reports uncached input and each cache counter as separate additive categories. An adapter that passes additive counters through unchanged underbills every cached turn — see issue [#356](https://github.com/haowjy/meridian-flow/issues/356). |
| OpenRouter | `openrouter` adapter reuses the OpenAI-compatible wire shape and owns provider-reported cost enrichment via `/generation`. |
| Cancel settlement | `Gateway.settleCancelledResult()` owns interrupted-call reconciliation and persist decisions. Generic token/missing-usage handling lives in `gateway/domain/cancel-settlement.ts`; OpenRouter-specific `/generation` settlement lives under `gateway/adapters/openrouter/`. The loop only asks the gateway to settle and then finalizes cancellation. |
| Tool-arg JSON repair | `gateway/helpers/parse-tool-arguments.ts` repairs malformed provider JSON (e.g. unquoted hex hash `"in": 6c4a`) via `jsonrepair` before falling back to a typed `ToolArgsParseError` sentinel. Unrepairable input surfaces a clear model-actionable parse error instead of degrading into misleading downstream schema errors. See issue [#113](https://github.com/haowjy/meridian-flow/issues/113). |
| Instrumentation | `instrumented-gateway.ts` decorates the `Gateway` port once in `createProductionAppPorts` (`lib/compose.ts`), emitting `gateway`-source lifecycle events (`stream.open`/`first_output`/`retry`/`close`; per-chunk only under `OBS_VERBOSE=gateway.chunks`, dev/test-only) keyed by `correlation.gatewayCallId`. A `Gateway` constructed outside that seam bypasses instrumentation — intentional for tests, wrong for production consumers. Verbosity is resolved from the injected environment at that seam (`resolveObsVerbose({ rawNodeEnv, obsVerbose })` in `lib/compose.ts`), not a module-level `process.env` read — tests inject `OBS_VERBOSE`; a module-level const would bypass them. |
| Model-request inspection | Immediately before `Gateway.stream()`, the orchestrator offers the provider-neutral `GenerateRequest` to a capture port. Disabled capture does not serialize it. Local dev/test capture shares `gatewayCallId` with lifecycle events and retains at most 200 records, 2 MiB per request, and 16 MiB total; exact-call reads include the preceding request for prefix comparison. The gate cannot enable capture in staging or production, and content never enters `EventSink`, thread snapshots, the event journal, or JSONL. |

Canonical gateway types live in `gateway/domain/types.ts`.

## loop — orchestrator + turn runner

One turn = one user message through potentially many LLM-call + tool-execution
iterations. The loop is intentionally decomposed; `orchestrator.ts` owns the
skeleton and delegates the moving parts.

| File | Role |
|---|---|
| `orchestrator.ts` | `createOrchestrator` / `runTurn` skeleton, user/assistant turn creation, iteration control, final yield of events. |
| `block-helpers.ts` | Content block conversion and local accumulator helpers. |
| `turn-accounting.ts` | Credit ledger checks/debits and cumulative usage events. |
| `interrupt-session.ts` | Same-turn interrupt suspend/resume mechanics and component-block updates. |
| `tool-dispatch.ts` | Permission check, tool execution ordering, result event shaping. |
| `run-turn-port.ts` | `RunTurnPort` plus `createLateBindRunTurnPort()` to break the runner/orchestrator/child-run cycle. |
| `interrupts.ts` | `InterruptRegistry` factory; process-local pending interrupt promises plus restart recovery from the event journal. No module-global registry state. |
| `context-builder.ts` | Builds `Message[]` + `Tool[]`; sends frozen `composedSystemPrompt` verbatim when baked; formats transient safety notices injected by the orchestrator. |
| `composed-system-prompt.ts` | Assembles and re-bakes the gateway system prompt from the agent body, skills catalog, frozen Work context, core document dialect, and runtime URI instruction; freeze sentinel is `bakedSkillSlugs !== null`. Frozen at first turn attempt (context assembly), even if the send fails or is cancelled; autoprune is the only future re-bake trigger. |
| `work-context.ts` / `work-context-delivery.ts` | Reads authoritative Work identity with rendered context and owns durable delivery/recovery behind the deep `WorkContextDelivery` port. Every Work-list change queues eligible live threads. Post-commit wakes drain idle threads, running threads flush at completion, and a startup/poll sweep recovers obligations across process recreation. |
| `system-instructions/` | Model-facing prompt assets independent of any agent body. `document-dialect.ts` owns Meridian document language and its codec-backed spelling contract; `runtime-uris.ts` owns context namespace guidance. Tool descriptions continue to own mechanics. |
| `streaming.ts` | Maps gateway `StreamEvent`s to `OrchestratorEvent` stream deltas and extracts tool calls. |
| `finalization.ts` | Terminal turn status + thread status transitions. Failed turn generator → `turn.error` (no more stuck "streaming"). |
| `persistence.ts` | Transactional persist/project-then-emit helper. **Ordering**: `projectReadModelEvent` runs before `eventWriter.appendEvent` so the `event_journal.turn_id` FK can reference the turn row created by the projector. Both happen in the same repo transaction. |
| `permissions/` | `PermissionGate`; compose currently wires the `coding` profile explicitly. |

`OrchestratorDeps` is fully required: gateway, repos, package repository, tool
registry/executor, project preferences, permission gate, credit ledger,
interrupt artifact flush, child-run coordinator, interrupt registry, and
`EventSink` are all explicit dependencies. Provider-specific model-call behavior
stays behind the gateway port. Disabled behavior is represented by explicit
adapters (for example no-op sinks), not by omitted deps.

## tools — registry, executor, and handlers

| Concern | Detail |
|---|---|
| `ToolRegistry` | Name-keyed map. Duplicate names throw immediately. `getDefinitions()` advertises only server-executable registrations whose `advertise !== false`. |
| `ToolExecutor` | Dispatches `ToolCallInput` to registered handlers with timeout, abort, sequential execution, and capability-gated context injection. |
| `ToolRegistration` | `source: "core" | "spawn" | "skill"`, `definition`, `execution`, optional `timeoutMs`, `sequential`, `advertise`, one privileged `capability`, and optional `formatExecutionError` when a tool owns its model-facing error protocol. |
| Core handlers | The strict six-branch `work` union and other definitions live in `tools/core-tools.ts`; composition wires their handlers through `lib/wired-core-tools.ts`. |
| Skill tools | One statically registered `invoke` dispatcher (`source: "skill"`, `advertise: false`) with schema `{ skillname }` only (`additionalProperties: false`). First turn attempt atomically bakes model-invocable skill catalogs (slug + description rows) into `composedSystemPrompt` and persists `bakedSkillSlugs` via compare-and-swap (`bakeComposedSystemPrompt` while `bakedSkillSlugs` is null); concurrent losers use the winner's frozen prompt. `invoke` advertisement on later turns follows the persisted slug set (non-empty → advertise). Dispatch enforces: `skillname` ∈ baked set (added-after-bake → unknown); still model-invocable and resolvable (demoted/deleted → no-longer-available). Extra invoke properties from frozen prompts are ignored; skills read project workspace context, not call-time params. Error listings = baked ∩ currently-invocable. Subagent threads bake both fields at creation (empty set when no skills). |
| Spawn tools | `tools/spawn-tools.ts` registers `spawn` and `return_result` with explicit privileged capabilities. |

Handler-owned `{ isError: true, output }` results already define their
model-facing protocol, so the executor preserves their output by definition.
Parse, timeout, abort, and thrown failures belong to the executor; it delegates
those to the registration's `formatExecutionError` when present and otherwise
uses the generic Meridian error format. The `write` registration owns such a
formatter so every executor-owned write failure still returns
`meridian.agent-edit.v1` without teaching the generic executor about agent-edit.

The core-tool publication boundary lives in `tools/core-tools.ts`: definitions,
names, and constraints are canonical there, but `createCoreToolRegistrations()`
requires handlers for every core tool. The composition root supplies executable
behavior; schema-only stubs are not advertised.

## spawn / child runs

`spawn/child-run-coordinator.ts` supervises nested agent execution. It consumes
`RunTurnPort`, `ChildRunRegistry` from the turn runner, `CreditLedger`, package
metadata, and the threads repository's `SubagentThreadFactory` seam. Route-facing
thread creation still goes through public thread creation normalization; only the
child-run coordinator can create subagent threads.

### Vocabulary note

- **spawn** = the act exposed by the tool and emitted events.
- **child run** = the supervised execution (`ChildRunCoordinator`, child-run registry).
- **subagent thread** = the thread kind and creation seam (`SubagentThreadFactory`).

These are one concept-cluster with three facets; use each name only for its
facet.

## Cost, billing, and permissions

- Tool permissions are enforced by `PermissionGate.check()` before dispatch.
  `lib/compose.ts` explicitly composes the pilot `coding` profile, which is
  currently allow-all.
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
- **Edit-intent notices** — before every provider stream, `runTurn` drains the
  single notice port for the thread and its active documents. Notices present
  before the first call attach to that writer message and remain there for every
  tool-loop iteration. Notices recorded mid-turn are inserted after the tool
  exchange that caused them and retain that causal position on later
  iterations. This keeps the already-sent request prefix stable without
  changing the frozen system prompt or persisting notices into the turn graph.
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
- **One running turn per thread** — `TurnRunner` rejects `startTurn` if a turn is
  already active or being claimed for that thread. The PostgreSQL adapter also
  rejects same-process reentry because session advisory locks themselves are
  reentrant. Production runners hold the cross-process claim through completion
  delivery; a crashed process loses its session claim, so startup recovery can
  safely take over orphaned work.
- **Work context updates preserve prompt identity** — a frozen prompt is never
  rebuilt for Work metadata or lifecycle changes. The refreshed block is a
  durable `<system_update>` user-role turn. Every Work or primary-binding
  mutation coalesces a durable per-thread obligation in its business
  transaction, whether or not the first prompt has frozen. Delivery renders
  current state under the thread-head transition and deletes the obligation only
  in the transaction that commits the update and its typed
  `work_context.changed` journal event. Direct writer mutations conservatively
  finish through one non-throwing `deliverAfterCommit`; in-run tool dispatch is
  the sole `deliverNow` owner. A
  post-commit wake and the startup/poll sweep drain idle obligations without
  becoming part of mutation success. Competing delivery claims hydrate the one
  committed update into a running orchestrator. A sweep must first claim durable
  run ownership and therefore leaves a remote live runner's obligation intact;
  the owner flushes it before releasing its claim. Tool-result pending metadata is
  presentation only; process recreation and retry recover from the obligation.
- **Registry names are global.** Duplicate registration names throw.
- **Gateway terminal outcome needs causal evidence.** The instrumented `stream.close` `outcome` is `ok`/`error`/`cancelled`. A failure becomes `cancelled` only with causal abort evidence: the thrown error is `signal.reason` or an `AbortError`. Message text alone (`"Aborted"`, `"Request aborted"`) is **not** evidence — a provider failing independently after an abort stays `error`, and `sleep`/cancel paths reject with `signal.reason` (or a synthesized `AbortError`) so their failures carry identity. A thrown error's string `.code` populates both the `stream.close` payload `errorCode` and `correlation.errorCode`.

## Cross-domain dependencies

- **Depends on `domains/threads`** — repositories, event journal, hub, and the
  subagent-thread creation seam.
- **Depends on `domains/packages`** — agent/skill resolution and spawn
  authorization.
- **Depends on `domains/billing` and `@meridian/contracts/spawn`** — credit ledger
  and tree budgets.
- **Depends on `domains/collab` at composition** — active-document resolution
  and response-scoped write settlement are supplied through runtime ports.
- **Consumed by `lib/` routes** — WS/HTTP handlers call
  `turnRunner.startTurn` / `turnRunner.cancel`; composition wires adapters.
- **No direct dependency on `domains/context`** — context-using tools receive
  handlers via DI at composition time.
