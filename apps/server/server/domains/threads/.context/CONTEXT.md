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
  thread). `threads.workId` column is **dropped**. Membership is organizational;
  same-project Work-authority URIs do not require membership.
- **Thread Work rebind** — `rebindThreadWork` is the canonical mutation for
  changing an existing thread's primary Work. It owns lifecycle validation,
  the transaction-composable binding transition, primary-thread sticky
  preference, the exact binding receipt, idempotent no-op behavior, and the
  targeted durable context refresh obligation. Writer and model commands share
  that transition; switch receipts are factual and are not reversible through
  turn Undo/Redo. The authenticated writer adapter additionally holds
  cross-process thread-run ownership across its transaction. Preflight
  absence remains concealed by the HTTP adapter; lifecycle-lock absence is a
  typed refreshable conflict, missing primary membership is a separate
  integrity conflict, and database failures propagate unchanged.
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
- **AI write mode** — `works.ai_write_mode` column (`'direct'` | `'draft'`)
  controls whether AI edits go into branch review or directly to live.
  The column is owned by the Work, not the thread. It is seeded from the
  project's `ProjectPreferences.aiWriteMode` at Work creation. Write-time
  routing resolves `thread → primary Work → works.ai_write_mode`.

  The write-mode route (`lib/work-write-mode-route.ts`) maps
  `aiWriteMode` → branch `pushPolicy` (`'direct'` → `'auto'`, `'draft'` →
  `'manual'`). Mode changes: `draft` → `direct` with active drafts requires
  explicit confirmation; the confirmed request pushes every pending Work draft
  to live before switching the policy. `direct` → `draft` is always permitted.

  → See [`domains/collab/.context/CONTEXT.md`](../../collab/.context/CONTEXT.md)
    for the branch review model.
- **Active documents** — `createActiveDocumentResolver` is the sole definition
  of document activity for a thread: the union of explicit `thread_documents`
  attachments and documents touched by the thread's turns. It also resolves
  active threads for a document so drain-time notice fan-out and retention use
  the same definition.

## Contracts (ports)

| Port | Surface |
|---|---|
| `ThreadRepository` | `create / findById / listByUser / listByProject / updateStatus / recomputeCostFromModelResponses / updateCost / softDelete / restore` |
| `HomeChatFeedRepository` | One server-owned Continue/Favorite/Recent projection with current-visible-lineage preview and keyset pagination. Production resolves a page in one set-oriented SQL statement; in-memory adapters preserve behavior, not query shape. |
| `ThreadUserStateRepository` | Per-writer favorite, manual-unread, and last-opened desired-state authority. |
| `TurnRepository` | `create / findById / listByThread / getLatestByThread / updateStatus / recomputeRollups` |
| `BlockRepository` | `create / findById / listByTurn / listByThread / updatePruned` |
| `ModelResponseRepository` | `create / findById / listByTurn` |
| `UsageRecorder` | `recordModelResponseUsage` — legacy helper retained for repository conformance/direct callers; runtime model responses now flow through the read-model projector |
| `ThreadRepositories` | aggregate of the above four + `transaction<T>` for atomic multi-repo writes + `runTurnStartTransition` for thread-row-serialized turn setup |
| `ThreadWorksRepository` | Adds organizational memberships, reads the primary, and rebinds the primary membership through one Work-before-thread critical section. Rebind accepts active or archived same-project Works and preserves exactly one primary. |
| `rebindThreadWork` | Transaction-composable mutation above `rebindPrimary`; binding, preference, receipt, and targeted durable obligation have one policy owner. Actor adapters own transaction and post-commit delivery. |
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
- **Turn start is a serialized thread transition.** `runTurnStartTransition`
  locks `threads.id`, verifies the expected active leaf did not advance, then
  holds that lock through orphaned-write reconciliation, next-parent reads,
  user/assistant turn projection, active-leaf updates, and journal append.
  Cross-instance losers receive `TurnStartConflictError`, never a raw unique
  violation. A pre-existing nonterminal leaf is not mistaken for a live owner
  after restart. Standalone turn creation also locks the thread so root
  insertion and active-leaf advancement commit atomically.
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
- A thread receives its project-unique slug when created with its first
  non-empty title, including the bootstrap `Chapter 1` conversation (`chapter-1`).
  Collisions use `-2`, `-3`, and later mutations never regenerate the handle;
  untitled threads keep `slug = null`.
- **Work membership mutation is serialized.** Primary additions and rebinds lock
  the current and target Works in canonical id order before the thread row;
  non-primary additions lock their target Work before the thread. A changed
  primary snapshot retries the whole transaction. This prevents deletion races,
  opposite lock orders, and concurrent moves validating stale primary state.
- Phase 1: only `kind: "primary"` threads with `spawnDepth: 0`.
  `normalizeThreadCreate` rejects all spawn/fork lifecycle fields.
- Hot cache is bounded at 500 events; older events fall through to journal
  replay (capped at 10,000 entries).
- Thread status is stored in DB using the domain vocabulary
  (`idle`, `active`, `blocked`, `error`, `archived`) and mapped back unchanged.
- `threads.active_leaf_turn_id` anchors one visible-conversational-head policy:
  projections walk its active lineage past hidden Work-context, compaction, and
  non-custom system turns. Home, project/Work lists, state mutation responses,
  and snapshots all derive effective attention from that head and the complete
  writer state. Set-oriented SQL companions are parity-tested against the named
  domain policy. The closed `attention` enum uses `thread_user_state`: a
  `waiting_interrupt` assistant head is `actionRequired`, and an idle completed
  assistant head newer than the writer's acknowledgement is `unread`.
- Home returns Continue and Favorites only on the first page. Recent pagination
  uses an opaque exclusive cursor over `(lastActivityAt DESC, threadId DESC)`;
  every page excludes Continue and Favorites, so equal activity times remain
  stable without duplicating a chat.
- Opening a thread sends `{ isUnread: false }` to
  `PATCH /api/threads/:threadId/user-state`. Mark-read/open clears the manual
  override and monotonically advances `last_opened_at` using database time;
  mark-unread sets the durable override without moving that timestamp. The
  partial desired-state mutation is one statement and preserves omitted fields.
  Neither clears
  `actionRequired`, which has precedence.
- Draft-review attention remains an extension point. Establishing it requires
  collab-domain branch/journal queries and review-state semantics, so the
  threads projector currently sources `actionRequired` only from the durable
  `ask_user` interrupt status already on the logical-head turn.

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
