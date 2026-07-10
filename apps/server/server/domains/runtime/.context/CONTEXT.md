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
| OpenRouter | `openrouter` adapter reuses the OpenAI-compatible wire shape and owns provider-reported cost enrichment via `/generation`. |
| Cancel settlement | `Gateway.settleCancelledResult()` owns interrupted-call reconciliation and persist decisions. Generic token/missing-usage handling lives in `gateway/domain/cancel-settlement.ts`; OpenRouter-specific `/generation` settlement lives under `gateway/adapters/openrouter/`. The loop only asks the gateway to settle and then finalizes cancellation. |
| Tool-arg JSON repair | `gateway/helpers/parse-tool-arguments.ts` repairs malformed provider JSON (e.g. unquoted hex hash `"in": 6c4a`) via `jsonrepair` before falling back to a typed `ToolArgsParseError` sentinel. Unrepairable input surfaces a clear model-actionable parse error instead of degrading into misleading downstream schema errors. See issue [#113](https://github.com/haowjy/meridian-flow/issues/113). |

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
| `composed-system-prompt.ts` | Assembles and re-bakes the gateway system prompt; freeze sentinel is `bakedSkillSlugs !== null`. Frozen at first turn attempt (context assembly), even if the send fails or is cancelled; autoprune is the only future re-bake trigger. |
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
| `ToolRegistration` | `source: "core" | "spawn" | "skill"`, `definition`, `execution`, optional `timeoutMs`, `sequential`, `advertise`, and a single `capability?: "interrupt" | "spawn" | "return_result"`. |
| Core handlers | Algorithms live under `tools/core-handlers/`; composition wires them through `lib/wired-core-tools.ts`. |
| Skill tools | One statically registered `invoke` dispatcher (`source: "skill"`, `advertise: false`) with schema `{ skillname }` only (`additionalProperties: false`). First turn attempt atomically bakes model-invocable skill catalogs (slug + description rows) into `composedSystemPrompt` and persists `bakedSkillSlugs` via compare-and-swap (`bakeComposedSystemPrompt` while `bakedSkillSlugs` is null); concurrent losers use the winner's frozen prompt. `invoke` advertisement on later turns follows the persisted slug set (non-empty → advertise). Dispatch enforces: `skillname` ∈ baked set (added-after-bake → unknown); still model-invocable and resolvable (demoted/deleted → no-longer-available). Extra invoke properties from frozen prompts are ignored; skills read project workspace context, not call-time params. Error listings = baked ∩ currently-invocable. Subagent threads bake both fields at creation (empty set when no skills). |
| Spawn tools | `tools/spawn-tools.ts` registers `spawn` and `return_result` with explicit privileged capabilities. |

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
- `Usage` token counts are shared DTOs from `@meridian/contracts/runtime`; billing
  owns ledger behavior in `domains/billing`.

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
- **Safety notices** — before every provider stream, `runTurn` drains the single
  notice port for the thread and its active documents, then injects notices as a
  transient system message. Notices never enter the turn graph. Undo/redo uses
  `kind: "undo"`; rejections and late sweeps recorded mid-turn therefore reach
  the next model call in the same agentic loop.
- **Model response lifecycle** — `persistModelResponse` mints the response id
  used by tool handlers. After all tool results for that response are persisted,
  the orchestrator commits response-scoped agent-edit writes; cancellation paths
  roll the response buffer back before finalizing the turn as cancelled.
- **One running turn per thread** — `TurnRunner` rejects `startTurn` if a turn is
  already active for that thread.
- **Registry names are global.** Duplicate registration names throw.

## Cross-domain dependencies

- **Depends on `domains/threads`** — repositories, event journal, hub, and the
  subagent-thread creation seam.
- **Depends on `domains/packages`** — agent/skill resolution and spawn
  authorization.
- **Depends on `domains/billing` and `@meridian/contracts/spawn`** — credit ledger
  and tree budgets.
- **Consumed by `lib/` routes** — WS/HTTP handlers call
  `turnRunner.startTurn` / `turnRunner.cancel`; composition wires adapters.
- **No direct dependency on `domains/context`** — context-using tools receive
  handlers via DI at composition time.
