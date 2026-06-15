# domains/threads — thread persistence & event spine

Owns the durable state for threads, turns, blocks, and model responses, plus
the event journal that bridges orchestrator writes to AG-UI client streams.

## What it owns

- **Thread / Turn / Block / ModelResponse repositories** — CRUD for the
  conversation data model. A thread contains turns; a turn contains blocks
  (text, reasoning, tool_use, tool_result, image, file, custom) and model
  responses with token/cost rollups.
- **Event journal** — append-only log of `OrchestratorEvent` payloads per
  thread, used for replay and real-time fan-out. Model-response and block rows
  are now projected from durable journal facts, not authored directly by the
  runtime loop.
- **ThreadEventHub** — in-memory pub/sub + hot cache that sits on top of the
  journal. Subscribers get live events; late joiners get catchup via hot cache
  or journal replay. Eviction on idle (grace period, default 60 s).
- **Orchestrator event projector** — stateful transform from
  `OrchestratorEvent` to AG-UI events (run lifecycle, text/reasoning
  streaming, tool call lifecycle, usage, permissions).
- **Read-model projector** — synchronous in-transaction transform from durable
  `turn.created` / `model.response_received` / `block.upserted` events to
  `turns`, `model_responses`, `turn_blocks`, and recomputed token/cost rollups.
- **Thread snapshot builder** — assembles the full `ThreadSnapshotResponse`
  (thread + turns + blocks + responses + live state) for initial page load.
- **Thread lifecycle validation** — `normalizeThreadCreate` enforces Phase 1
  constraints (primary root threads only; spawn/fork fields rejected).
- **Access control** — `requireThreadOwner` gates thread operations behind
  ownership + project ownership, returning 404 on any mismatch to avoid
  existence leaks.

## Contracts (ports)

| Port | Surface |
|---|---|
| `ThreadRepository` | `create / findById / listByUser / listByProject / updateStatus / recomputeCostFromModelResponses / updateCost / softDelete / restore` |
| `TurnRepository` | `create / findById / listByThread / getLatestByThread / updateStatus / recomputeRollups` |
| `BlockRepository` | `create / findById / listByTurn / listByThread / updatePruned` |
| `ModelResponseRepository` | `create / findById / listByTurn` |
| `UsageRecorder` | `recordModelResponseUsage` — legacy helper retained for repository conformance/direct callers; runtime model responses now flow through the read-model projector |
| `ThreadRepositories` | aggregate of the above four + `transaction<T>` for atomic multi-repo writes |
| `EventJournalWriter` | `appendEvent(threadId, event) -> bigint seq` |
| `EventJournalReader` | `readAfter / headSeq / listByThread / listByType / listSince / listByTimeRange` |

Entity types (`Thread`, `Turn`, `Block`, `ModelResponse`) and event unions
(`OrchestratorEvent`) live in `@meridian/contracts/threads`. All are JSON-natural.

## Adapters

- **Drizzle** (production) and **in-memory** (test/dev) adapters for all
  repositories and journal reader/writer, behind shared `__conformance__`
  suites.

## Key domain logic

- **ThreadEventHub sequencing** — journal `seq` is multiplied by 1000
  (`EVENT_SEQ_FACTOR`) to leave room for multiple AG-UI events projected from
  a single journal entry. Cursor arithmetic uses this factor.
- **catchupAndSubscribe** — installs a guard listener to buffer live events
  during journal replay, then merges + deduplicates so nothing is lost between
  replay completion and subscription hand-off.
- **Orchestrator event projector** — tracks open text/reasoning message IDs
  and started tool calls to emit correct start/end bracketing for AG-UI.
  Finalizes run on `turn.completed`, `turn.cancelled`, or `turn.error`.

## Schema adaptation (Upstream → Meridian Flow)

The Drizzle adapters were copied from the upstream codebase and adapted to
Meridian Flow's Supabase/Postgres schema. Key column mappings:

| Upstream | Meridian Flow | Notes |
|---|---|---|
| `threads.projectId` | `threads.projectId` | Meridian uses `projects`, not `projects` |
| `threads.createdBy` | `threads.createdByUserId` | Explicit user-ID column name |
| `threads.currentAgent` | `threads.currentAgentId` | Agent ID column |
| `threads.rootThreadId` | — | Computed as `parentThreadId ?? id` |
| `threads.totalCostUsd` | — | Not a column; hardcoded `"0"` in mapper |
| `threads.bakedSkillSlugs` | — | Not a column; freeze detected by `composedSystemPrompt` presence |
| `threads.historySummary` | — | Not a column; hardcoded `null` |
| `turns.model` / `turns.provider` | — | Not columns; hardcoded `null` in mapper |
| `turns.requestParams` | — | Not a column; hardcoded `null` |
| `turns.responseMetadata` | — | Not a column; hardcoded `null` |
| `turnBlocks.provider` / `turnBlocks.providerData` | — | Not columns; hardcoded `null` in mapper |
| `modelResponses.rawUsage` | `modelResponses.usageBreakdown` | Column renamed |
| `modelResponses.providerRequestId` | `modelResponses.providerRequestId` | |
| `modelResponses.priceSource` | `modelResponses.priceSource` | Default `computed` |
| `modelResponses.pricingSnapshot` | `modelResponses.pricingSnapshot` | |
| `modelResponses.finishReason` | `modelResponses.stopReason` | Column renamed |

### Date handling

Drizzle `timestamp` columns accept native `Date` objects (not ISO strings).
All repository writes use `new Date()` directly; the `toDate()` helper in
`domain/contract-serialization.ts` coerces ISO strings from contracts to `Date`
for repository insertion. The `toIsoString()` helper remains for contract output.

### `modelText` null-safety

`turn_blocks.modelText` is `NOT NULL DEFAULT ''` in the Meridian Flow schema.
The `mapBlock` mapper handles this with `const modelText = row.modelText ?? ""`
to prevent null from leaking into contract shapes.

## Invariants

- **Read-model projection before journal append.** The persistence helper
  (`runtime/loop/persistence.ts`) runs `projectReadModelEvent` before
  `eventWriter.appendEvent` so that `event_journal.turn_id` FK can reference
  the turn row created by the projector. Both happen in the same transaction.
- A thread's `totalCostUsd` is the sum of all model response costs for its turns,
  recomputed by the read-model projector from `model_responses`. `updateCost`
  remains only for direct lifecycle/counter writes such as `turnCount`.
- Turn rollups (`totalCostUsd`, `inputTokens`, `outputTokens`, etc.) are
  recomputed atomically from `model_responses` by the read-model projector as
  `model.response_received` events are appended, so journal replay is idempotent.
- **Freeze sentinel**: a thread's system prompt is considered "baked" (frozen) when
  `composedSystemPrompt` is non-null. Meridian Flow does not use `bakedSkillSlugs`;
  the `mapThread` mapper sets `bakedSkillSlugs: null` and detects frozen state via
  `Boolean(row.composedSystemPrompt)`.
- Soft-delete (`deletedAt`) is idempotent for both threads and the
  `requireThreadOwner` gate treats soft-deleted threads as 404.
- Phase 1: only `kind: "primary"` threads with `spawnDepth: 0`.
  `normalizeThreadCreate` rejects all spawn/fork lifecycle fields.
- Hot cache is bounded at 500 events; older events fall through to journal
  replay (capped at 10,000 entries).
- Thread status: `"active"` in DB for new threads; mapper maps `"archived"` →
  `"archived"`, everything else → `"idle"`.

## Cross-domain dependencies

- **Consumed by `domains/runtime`** — the orchestrator and turn-runner depend
  on `ThreadRepositories`, `EventJournalWriter`, and `ThreadEventHub` for
  persistence and event fan-out.
- **Consumed by `lib/` routes** — HTTP/WS handlers use `requireThreadOwner`,
  `buildThreadSnapshot`, and `ThreadEventHub.catchupAndSubscribe`.
- **Depends on `@meridian/contracts`** — entity types, `OrchestratorEvent`,
  AG-UI event schemas.
- **Depends on `@meridian/database/schema`** — Drizzle table definitions for
  the Meridian Flow Supabase/Postgres schema.
