# domains/threads — thread persistence & event spine (M:N work model)

Owns the durable state for threads, turns, blocks, and model responses, plus
the event journal that bridges orchestrator writes to AG-UI client streams.
Threads now use an M:N membership model with Works (`thread_works` join table)
instead of the N:1 `threads.workId` column.

`domain/bound-conversation.ts` owns atomic thread creation, retained Agent configuration and optional Work membership. Root and child creation and the `derive-conversation.ts` handoff/fork operations use it. Derived requests require exact catalog selection rather than mutable target slugs; each mode includes required history and provenance writes in its outer transaction. Spawn execution begins only after commit.

## What it owns

- **Thread / Turn / Block / ModelResponse repositories** — CRUD for the
  conversation data model. A thread contains turns; a turn contains blocks
  (text, reasoning, tool_use, tool_result, image, file, custom) and model
  responses with token/cost rollups.
- **Child-report delivery obligations** — `child_report_deliveries` (schema in
  `agent-threads.ts`) is the durable "undelivered background report" marker,
  one row per child execution keyed by the child run's assistant turn id
  (`report_id`), carrying `submission_epoch` and a reused nullable
  `system_turn_id`. Enqueued atomically with the child's terminal lifecycle and
  deleted once the parent continuation is durably admitted. Delivered by
  `domains/runtime/spawn/child-report-delivery.ts`.
- **Thread↔Work membership** — `thread_works` join table (exactly one primary per live thread; No Work is a real row). `threads.workId` column is **dropped**. Membership is organizational;
  same-project Work-authority URIs do not require membership.
- **Thread Work rebind** — `rebindThreadWork` is the canonical mutation for
  explicitly changing an existing thread's primary Work. It owns lifecycle validation,
  the transaction-composable binding transition, the exact binding receipt, idempotent no-op behavior, and the
      targeted durable context refresh obligation. Writer and model commands share
      that transition; switch receipts are factual and are not reversible through
      turn Undo/Redo. The authenticated writer adapter additionally holds
      cross-process thread-run ownership across its transaction. Preflight
      absence remains concealed by the HTTP adapter; lifecycle-lock absence is a
      typed refreshable conflict, No Work receipts use a Work id and null slug, and database failures propagate unchanged.
- **Event journal** — append-only log of `OrchestratorEvent` payloads per
  thread, used for replay and real-time fan-out. Model-response and block rows
  are now projected from durable journal facts, not authored directly by the
  runtime loop. Delivery cursors use `threads.next_seq` and
  `event_journal.seq` (unique `(thread_id, seq)`). `seq` is event-delivery
  cursoring for `readAfter`, the writer increment, and hub resume math — not
  turn ordering. The turn tree (`parent_turn_id`, `active_leaf_turn_id`) remains
  the ordering model. Turns have no `seq` column.
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
  Subagent snapshots include `parent: { id, title }` from a `findById` point
  lookup, not the parent's conversation.
- **Thread lifecycle validation** — public create (`normalizeThreadCreate`)
  accepts primary roots only and rejects spawn/fork fields. Subagent threads
  are created only by `SubagentThreadFactory` from the child-run coordinator.
- **Access control** — `requireThreadOwner` gates thread operations behind
  ownership + project ownership, returning 404 on any mismatch to avoid
  existence leaks.
- **AI write mode** — `works.ai_write_mode` column (`'direct'` | `'draft'`)
  controls whether AI edits go into branch review or directly to live.
  The column is owned by the Work, not the thread. It is seeded from the
  project's `ProjectPreferences.aiWriteMode` at Work creation. Write-time routing resolves `thread → primary Work → works.ai_write_mode`. Missing primary is corrupt. No Work uses the same column; `draftOwner` is null only for Auto-apply.

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
| `ThreadRepository` | Thread lifecycle plus writer-facing project lists (`kind: "primary"` only) and the hard-bounded `listRecentByWork` model summary. It does not expose an unbounded Work list. Get-by-id still returns subagents. |
| `HomeChatFeedRepository` | Continue/Favorite/Recent policy over the neutral Project-chat projection of primary threads. Home retains its set-oriented whole-project ranking. |
| `WorkChatFeedRepository` | Bounded historical-Work association pages over the same primary Project-chat projection, ordered by `(threads.updated_at DESC, threads.id DESC)`. |
| `ThreadUserStateRepository` | Per-writer favorite authority. |
| `TurnRepository` | `create / findById / listByThread / getLatestByThread / updateStatus / recomputeRollups` |
| `BlockRepository` | `create / findById / listByTurn / listByThread / updatePruned` |
| `ModelResponseRepository` | `create / findById / listByTurn` |
| `UsageRecorder` | `recordModelResponseUsage` — legacy helper retained for repository conformance/direct callers; runtime model responses now flow through the read-model projector |
| `ThreadRepositories` | aggregate of the above four + `transaction<T>` for atomic multi-repo writes + `runTurnStartTransition` for thread-row-serialized turn setup |
| `ThreadWorksRepository` | Adds organizational memberships and reads the primary. Its Work-before-thread primary rebind revalidates thread lifecycle under the same row lock, then demotes the old membership and promotes/upserts the target WorkId, retaining association history while preserving exactly one primary. |
| `rebindThreadWork` | Transaction-composable mutation above `rebindPrimary`; binding, receipt, typed lifecycle errors, and targeted durable obligation have one policy owner. Actor adapters own transaction and post-commit delivery. |
| `restoreOwnedThreadFromTrash` | Authenticated restore boundary; revalidates historical primary Work then thread under Work-before-thread locks. It restores the exact available Work, or rebinds an unavailable historical primary to No Work. |
| `EventJournalWriter` | `appendEvent(threadId, event) -> bigint seq` |
| `EventJournalReader` | `readAfter / headSeq / listByThread / listByType / listSince / listByTimeRange` |
| `ChildReportDeliveryRepository` | Durable exactly-once delivery facts for a background child's terminal report: `enqueue` (idempotent on `report_id`, enlists in the ambient transaction), pending-parent listing, `findByReportId`, one-time `setSystemTurnId`, `advanceEpoch` after a terminally rejected attempt, and `acknowledge`. |

Entity types (`Thread`, `Turn`, `Block`, `ModelResponse`) and event unions
(`OrchestratorEvent`) live in `@meridian/contracts/threads`. All are JSON-natural.

## Adapters

- **Drizzle** (production) and **in-memory** (test/dev) adapters for all
  repositories and journal reader/writer. The focused Project-chat adapter owns
  Home and Work visible-head projection in memory; the Drizzle projection module
  owns the shared row mapping, preview, action-required fact, timestamp, and bounded Work
  candidate machinery.

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
| `threads.agentName` | **binding join** (`thread_agent_bindings` → `agent_definition_revisions`) | Display name (`metadata.name` or slug), or `Subagent` when the binding has no revision; never a threads column |
| `threads.rootThreadId` | `threads.rootThreadId` | Persisted spawn-tree root; primary threads use their own ID |
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

- **Child creation starts unfrozen.** `SubagentThreadFactory` initializes prompt,
  skill-freeze state, and prompt hash to null. The coordinator commits the retained
  Agent binding and Work membership with creation; shared runtime preparation
  owns the first bake.

- **Read-model projection before journal append.** The persistence helper
  (`runtime/loop/persistence.ts`) runs `projectReadModelEvent` before
  `eventWriter.appendEvent` so that `event_journal.turn_id` FK can reference
  the turn row created by the projector. Both happen in the same transaction.
- **Turn start is a serialized thread transition.** `runTurnStartTransition`
  locks `threads.id`, verifies the expected active leaf did not advance, then
  holds that lock through orphaned-write reconciliation, next-parent reads,
  user/assistant turn projection, active-leaf updates, and journal append.
  Cross-instance losers receive `TurnStartConflictError` (`already_exists` or
  `already_running`), mapped to HTTP 409, never a raw unique violation. A
  pre-existing nonterminal leaf is not mistaken for a live owner after restart.
  Standalone turn creation also locks the thread so root insertion and
  active-leaf advancement commit atomically. Do not map `23505` to 409: the
  unique constraint is a post-hoc signal after stale snapshot reads, and it
  does not cover two concurrent starts against a non-empty thread. The
  in-memory adapter serializes every snapshot transaction on a process-wide
  `transactionTail` chain (with an `AsyncLocalStorage` reentrancy guard);
  per-transaction snapshots that interleaved across threads could erase winner
  state on loser rollback. Durable live-run ownership across the cluster is a
  separate problem ([#365](https://github.com/haowjy/meridian-flow/issues/365)).
- A thread's `totalCostUsd` is the sum of all model response costs for its turns,
  recomputed by the read-model projector from `model_responses`. `updateCost`
  remains only for direct lifecycle/counter writes such as `turnCount`.
- Turn rollups (`totalCostUsd`, `inputTokens`, `outputTokens`,
  `reasoningTokens`, cache tokens, `responseCount`, latest `model`/`provider`)
  are recomputed atomically from `model_responses` by the read-model projector as
  `model.response_received` events are appended, so journal replay is idempotent.
- **Freeze sentinel**: a thread's system prompt is considered "baked" (frozen)
  when `bakedSkillSlugs` is non-null. The first-attempt CAS returns the complete
  winning prompt and skill set to every contender. The retained Agent definition
  supplies preparation identity; `agentName` is the bound revision display name from that join.
- The owner-aware trash command is the sole thread soft-delete/restore boundary.
  It locks the including-deleted thread row, then revalidates thread and live
  project ownership before deciding either desired state. Missing and concealed
  threads have the same thread-scoped not-found result.
- **The complete trash command set is serialized.** Delete and restore decide
  changed/no-op from the locked row. Only a real `deleted -> visible` transition
  enqueues its targeted Work-context obligation; retries, concurrent no-ops, and
  deletion never wake delivery.
- Trash preserves the last committed primary membership as history. A deleted
  thread has no active scope. Restore never substitutes a same-name Work: membership follows Work ID, and a missing/deleted historical
  primary remains associated but non-primary after restore binds No Work.
- A thread receives a project-scoped `ref` in the create transaction:
  primaries take `c1`, `c2`, … and subagents take `p1`, `p2`, … from one
  shared per-project counter, so every live handle is project-unique. The
  handle grammar (`cN`/`pN`) lives in `domain/thread-ref.ts`
  (`formatThreadRef`/`parseThreadRef`); allocation stays with the repository
  adapters. Title is not an identifier and is not unique. Chat URLs use the
  client-minted thread `id`, not `ref`.
  Create-or-get matches ownership only. A same-user same-project retry of a
  deleted thread conflicts; persist must not resurrect the tombstone.
- **Work membership mutation is serialized.** Primary additions and rebinds lock
  the current and target Works in canonical id order before the thread row;
  non-primary additions lock their target Work before the thread. A changed
  primary snapshot retries the whole transaction. This prevents deletion races,
  opposite lock orders, and concurrent moves validating stale primary state.
- Public create accepts only `kind: "primary"` with `spawnDepth: 0`.
  `normalizeThreadCreate` rejects all spawn/fork lifecycle fields.
  Subagent rows are created only through `SubagentThreadFactory`.
- Hot cache is bounded at 500 events; older events fall through to journal
  replay (capped at 10,000 entries).
- Thread status is stored in DB using the domain vocabulary
  (`idle`, `active`, `blocked`, `error`, `archived`) and mapped back unchanged.
- `threads.active_leaf_turn_id` anchors one visible-conversational-head policy:
  projections walk its active lineage past hidden Work-context, compaction,
  child-report continuations, and non-custom system turns. Both visible-turn
  mirrors (`domain/visible-conversation-policy.ts` and the app's
  `visible-chat-turns.ts`) exclude the `child_report` system-update section so
  the model-visible report never renders as a writer message. Home, project/Work
  lists, and snapshots derive the
  independent `actionRequired` fact from a `waiting_interrupt` assistant head.
  Set-oriented SQL companions are parity-tested against the named domain policy.
- Home returns Continue and Favorites only on the first page. Recent pagination
  uses the strict shared Project-chat keyset codec over `(lastActivityAt DESC, threadId DESC)`;
  every page excludes Continue and Favorites, so equal activity times remain
  stable without duplicating a chat. Home, the project switcher (`listByProject`),
  and Work-associated chats list `kind: "primary"` only. Subagent Open is get-by-id.
- Work-associated chat pages use the same codec over thread update
  time plus thread ID. The association filter is M:N history among primary
  threads; row Work identity always comes from the current primary membership.
  Bound Agent name is projected from the same binding join as thread list
  (`metadata.name` or slug, or `Subagent` when the binding has no revision) and
  is the writer-facing row identity.
  Projection and serialization are bounded to 50 rows per page.
- Project chat lists have no read/unread state. The user-state route and
  repository persist Favorite only; opening a chat performs no state mutation.
- Draft-review action-required state remains an extension point. Establishing it requires
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
