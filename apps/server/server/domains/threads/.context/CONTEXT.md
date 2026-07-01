# domains/threads — thread persistence & event spine (M:N work model)

Owns the durable state for threads, turns, blocks, and model responses, plus
the event journal that bridges orchestrator writes to AG-UI client streams.
Threads now use an M:N membership model with Works (`thread_works` join table)
instead of the N:1 `threads.workId` column.

## What it owns

- **Thread / Turn / Block / ModelResponse repositories** — CRUD for the
  conversation data model. A thread contains turns; a turn contains blocks
  (text, reasoning, tool_use, tool_result, image, file, custom) and model
  responses with token/cost rollups.
- **Thread↔Work membership** — `thread_works` join table (one primary per
  thread). `threads.workId` column is **dropped**. Work-authority URIs resolve
  through membership.
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
- **AI write mode** — `threads.aiWriteMode` column (`'direct'` | `'draft'`)
  controls whether AI edits go straight to the live document or into a
  per-thread review draft. The column is seeded from the project's
  `ProjectPreferences.aiWriteMode` at thread creation (`lib/thread-creation.ts`);
  the thread-level value is authoritative for all subsequent writes.

  A write-mode switch route (`lib/thread-write-mode-route.ts`) handles mode
  changes: `draft` → `direct` is blocked while active drafts exist (HTTP 409);
  `direct` → `draft` is always permitted. The route-core function
  (`handleThreadWriteModeRequest`) owns validation, draft guard, and the
  mode update; the Nitro wrapper at
  `routes/api/threads/[threadId]/write-mode.patch.ts` is a thin transport adapter.

  → See [`domains/collab/.context/CONTEXT.md`](../collab/.context/CONTEXT.md)
    for the draft review lifecycle.

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
Meridian Flow's Postgres schema. Key column mappings:

| Upstream | Meridian Flow | Notes |
|---|---|---|
| `threads.projectId` | `threads.projectId` | Foreign key into Meridian `projects` |
| `threads.createdBy` | `threads.createdByUserId` | Explicit user-ID column name |
| `threads.currentAgent` | `threads.currentAgentId` | Agent ID column |
| `threads.rootThreadId` | — | Computed as `parentThreadId ?? id` |
| `threads.totalCostUsd` | `threads.totalCostUsd` | Persisted aggregate maintained by repository/projector recompute |
| `threads.bakedSkillSlugs` | `threads.bakedSkillSlugs` | `null` means not baked; array means first-attempt bake won |
| `threads.historySummary` | — | Not a column; hardcoded `null` |
| `turns.model` / `turns.provider` | `turns.model` / `turns.provider` | Latest model response for the turn |
| `turns.requestParams` | `turns.requestParams` | Request params captured when the turn row is created |
| `turns.responseMetadata` | `turns.responseMetadata` | Latest response metadata projected onto the turn |
| `turnBlocks.provider` / `turnBlocks.providerData` | `turnBlocks.provider` / `turnBlocks.providerData` | Provider metadata for projected block rows |
| `modelResponses.rawUsage` | `modelResponses.usageBreakdown` | Column renamed |
| `modelResponses.finishReason` | `modelResponses.stopReason` | Column renamed |
| `threads.workId` (N:1) | **`thread_works` join** (M:N) | Column **dropped** in migration 0011; replaced by membership join with primary marker |

**Billing audit columns on `model_responses`** (added during cleanse):

| Column | Role |
|---|---|
| `provider_request_id` | OpenRouter generation ID / provider request ID for cost reconciliation |
| `price_source` | `"computed"`, `"provider_reported"`, `"configured_rate"`, or `"unknown"` |
| `pricing_snapshot` | JSONB copy of the pricing data used at billing time |

### Date handling

Drizzle `timestamp` columns accept native `Date` objects (not ISO strings).
All repository writes use `new Date()` directly; the `toDate()` helper in
`domain/contract-serialization.ts` coerces ISO strings from contracts to `Date`
for repository insertion. The `toIsoString()` helper remains for contract output.

### `modelText` null-safety

`turn_blocks.modelText` is nullable at the schema boundary, but the thread
contract exposes `modelText` as a string. The `mapBlock` mapper handles this with
`const modelText = row.modelText ?? ""` to prevent null from leaking into
contract shapes.

## Invariants

- **Read-model projection before journal append.** The persistence helper
  (`runtime/loop/persistence.ts`) runs `projectReadModelEvent` before
  `eventWriter.appendEvent` so that `event_journal.turn_id` FK can reference
  the turn row created by the projector. Both happen in the same transaction.
- A thread's `totalCostUsd` is the sum of all model response costs for its turns,
  recomputed by the read-model projector from `model_responses`. `updateCost`
  remains only for direct lifecycle/counter writes such as `turnCount`.
- Turn rollups (`totalCostUsd`, `inputTokens`, `outputTokens`,
  `reasoningTokens`, cache tokens, `responseCount`, latest `model`/`provider`)
  are recomputed atomically from `model_responses` by the read-model projector as
  `model.response_received` events are appended, so journal replay is idempotent.
- **Freeze sentinel**: a thread's system prompt is considered "baked" (frozen)
  when `bakedSkillSlugs` is non-null. Before bake, `composedSystemPrompt` may
  carry a raw pre-bake system prompt.
- Soft-delete (`deletedAt`) is idempotent for both threads and the
  `requireThreadOwner` gate treats soft-deleted threads as 404.
- Phase 1: only `kind: "primary"` threads with `spawnDepth: 0`.
  `normalizeThreadCreate` rejects all spawn/fork lifecycle fields.
- Hot cache is bounded at 500 events; older events fall through to journal
  replay (capped at 10,000 entries).
- Thread status is stored in DB using the domain vocabulary
  (`idle`, `active`, `blocked`, `error`, `archived`) and mapped back unchanged.

## Cross-domain dependencies

- **Consumed by `domains/runtime`** — the orchestrator and turn-runner depend
  on `ThreadRepositories`, `EventJournalWriter`, and `ThreadEventHub` for
  persistence and event fan-out.
- **Consumed by `lib/` routes** — HTTP/WS handlers use `requireThreadOwner`,
  `buildThreadSnapshot`, and `ThreadEventHub.catchupAndSubscribe`.
- **Depends on `@meridian/contracts`** — entity types, `OrchestratorEvent`,
  AG-UI event schemas.
- **Depends on `@meridian/database/schema`** — Drizzle table definitions for
  the Meridian Flow Postgres schema.
