# domains/threads — thread persistence & event spine

This domain owns durable threads, turns, blocks, model responses, and the event
journal that feeds AG-UI clients. Threads belong to projects and use
`thread_works` for Work membership: exactly one primary membership is active,
and No Work is a real Work row.

## Creation and derivation

`domain/bound-conversation.ts` is the atomic creation boundary for root and
child conversations. It retains Agent configuration and optional Work
membership. `derive-conversation.ts` owns fork and handoff creation; required
history and provenance are written in the outer transaction, and child
execution starts only after commit.

- A fork keeps the source's retained revision, resolved configuration,
  invocation overlay, and bake at its cutoff. It has no Agent selection of its
  own. Same owner/project plus the client id, `originType = fork`, and
  `kind = primary` is create-or-get; any other existing row conflicts.
- A handoff requires a destination id, cutoff, and Agent selection. It uses the
  same settled-cutoff rules and row-only create-or-get policy with
  `originType = handoff`. It starts independent background authority,
  accounting, provenance, and No Work Scratch. A destination run claim is
  acquired before creation; an unavailable claim returns `handoff_in_progress`
  without creating a row.
- Fork and handoff acquire the source and destination lifecycle locks, reject
  archived/deleted target Works, and roll back the destination on refusal. A
  delivered user turn is an accepted cutoff while its reply streams; queued
  turns remain beyond it. A subagent cannot be a derivation source.
- `requireDerivationCutoff` cuts exactly at the named turn and never moves it
  to an earlier settled one. It refuses a turn outside the source's effective
  transcript (`turn_not_in_transcript`), any unsettled turn (`pending`,
  `streaming`, `waiting_interrupt`) at or before it (409 `unsettled_history`),
  and a turn the UI offers no Fork or Hand off action on (400
  `turn_not_actionable`). `complete`, `cancelled`, and `error` are settled.
- Public creation accepts only a primary root (`kind: "primary"`,
  `spawnDepth: 0`). `SubagentThreadFactory` is the only subagent creation
  boundary and starts children unbaked. A subagent-only or generic binding
  cannot become a primary thread without selecting a primary Agent.
- Fork-history resolution (`thread-conversation-context.ts`) throws
  `ThreadConversationContextError` rather than falling back when lineage cannot
  be reconstructed; run preparation lands it as a failed turn on the writer's
  message.
- `threads.origin_turn_id` is `ON DELETE NO ACTION`: provenance is never nulled
  to let a source turn be deleted. Work purge keeps a deleted Work whose turns
  another Work's fork or handoff still inherits.
- `threads.derivation_source_thread_id` records the chat the writer acted on,
  independently of the cutoff owner; it is not a spawn-parent relationship.

The handoff seed is a pending system seed, not an inbox control or run turn.
Response rows on system seeds never supply prefix warmth or token baselines.
Runtime owns its brief, stop/retry behavior, and orphan recovery; see
[`runtime/handoff`](../../runtime/.context/handoff.md) and the
[HTTP contract](../../../../../../docs/api/thread-handoff.md).

`compaction_notes` is a system-update metadata section marking an admitted
optional Scratch-update step. It is durable conversation context, not a new
thread, folder, or ownership boundary. Runtime reads it to avoid granting a
fresh allowance after recovery; the writer transcript hides the instruction.

## Prompt lifetime and history

A thread's system prompt and advertised tool list freeze together at first
context assembly, including failed or cancelled provider attempts. Immutable
bytes live in `prompt_bakes`; `threads.initial_prompt_bake_id` is write-once,
and `turns.prompt_bake_id` marks later epoch boundaries. Database triggers
reject bake updates/deletes except owner-thread cascades and reject pointer
changes after the first non-null value.

The cached request prefix changes only at prompt-epoch boundaries, image
removals, or the explicit compaction rebalance seam. Model changes, deployments,
Agent revisions, and cache TTL changes do not silently rebake a thread; a
mid-thread change is a system notification in conversation. `bakeAt` and
`bakeInEffect` resolve completed owner-local boundaries in write-once
`turns.position` order. `bakeIdAt` is shared by runtime cache prediction and
fork/handoff derivation. `findCutoffOwnerThreadId` is the only cutoff-owner
lookup; callers do not walk parent turns themselves.

Work changes, notices, child results, and skills are conversation content, not
prompt or tool-list edits. A fork references the bake in effect at its cutoff
on the thread that owns the cutoff, so a fork of a fork can inherit a
grandsource boundary. A same-revision handoff references the acted-on thread's
current bake; an unfrozen source or a different Agent yields an unbaked target.
Advertised tools are untyped `jsonb` here: the runtime owns their shape. Fork and handoff seed turns render as user-role
`<system_update>` content. Turn metadata and failure-copy codecs are owned by
`domain/turn-metadata.ts` and `domain/failure-copy.ts`; the contracts package
owns their wire shapes. Raw provider causes stay in diagnostics/logs/`./mf`,
while `turn.error` stores writer copy. A failed reply's metadata carries
`reason`, the gateway's `retryable` verdict, and `providerError` as debug
evidence only; a non-retryable verdict renders as a provider-declined block but
never blocks a writer's explicit Retry, and provider text never enters event
logs.

## Durable state and event spine

- Repositories own threads, turns, blocks, model responses, execution reports,
  notifications, steering, Work membership, and active-document resolution.
  Model-response usage includes all turns in the thread, including branches;
  descendants report independently. Snapshot `threadUsage` carries raw totals
  (the app derives cache-hit rate from them); `inputTokens` includes cache reads
  and writes, and writes remain misses. Only calls whose provider reported
  cache counters enter the hit-rate denominator.
- `threads.workId` is absent. Membership history is retained in
  `thread_works`; `rebindThreadWork` is the one explicit writer rebind seam. It
  is idempotent and emits a targeted durable context-refresh inbox notice.
  The model's `work switch` never rebinds. Membership is organizational:
  same-project Work-authority URIs do not require it. Work deletion marks live
  primary chats and descendants with `deletedByWorkId` in the same transaction;
  independently trashed chats are not marked, and a cascaded chat cannot be
  restored until its Work is. Expired Work purge hard-deletes its marked chats.
  Restore follows the historical Work ID (never a same-name Work) or binds No
  Work when it is unavailable; a deleted thread has no active scope.
- `thread_inbox_messages` is the durable per-thread FIFO; the runtime Inbox
  owns adoption. `thread_run_leases` reports live-run state and is paired with
  the runtime session claim; `threads.status` remains lifecycle-only. Run
  liveness is read from the lease alone: the project list and
  `ThreadLiveState.runningTurnId` both surface its bound turn.
  The snapshot's `liveState.runState` is the chat's whole `RunState` record
  ([run state](../../runtime/.context/delivery.md#run-state)).
- Direct-child subagent activity (delivery mode and times from the execution
  report, current tool from the live lease) is `ThreadLiveState.activity` in the
  snapshot and WS `subscribed`, live-updated by `subagent.activity`
  (`meridian.subagent.activity` frame). It is never a turn block.
- The thread snapshot builder reads rows, live state, watermark, and journal
  head in one root repeatable-read view. Subagent snapshots add an `ancestors`
  chain, root-first through the direct parent.
- The append-only journal stores `OrchestratorEvent` facts. Read-model
  projection creates/updates turn, block, and model-response rows before the
  journal append in the same transaction, so `event_journal.turn_id` is valid.
  Journal `seq` is a delivery cursor, not transcript ordering; `turns.position`
  is the write-once transcript order.
- A live model request or tool call batches its deltas behind the write already
  in flight and merges adjacent deltas for the same block. Each batch reserves
  one contiguous sequence range and sends one notification. The runtime owns
  the per-scope byte bound and flushes before its durable events; the hub still
  owns projection and fan-out.
- `ThreadEventHub` is process-local pub/sub and hot cache over the durable
  journal. One ordered drain reads committed rows after its cursor. Catchup
  installs a guard listener, replays, then merges buffered live events without
  gaps. The hot cache is bounded at 500 events. For a warm hub, replay older
  than that cache seeks to the last projector reset strictly before the cursor's
  journal row, then projects the suffix. Terminal rows reset the projector;
  seeking into a reply without reconstructing it would change message ids and
  frame sub-indexes. The lookup uses the thread/seq index and may scan backward
  through a long unfinished reply. Cold hub initialization still reconstructs
  from journal zero and is O(history). Invalidations carry no event payload.
  Client cursors are journal `seq` times 1000 (`EVENT_SEQ_FACTOR`) so one
  journal entry can project several AG-UI events; sequence gaps from rolled-back
  allocations are legal.
- The orchestrator projector is stateful for open text/reasoning messages and
  tool calls. Every custom event name it emits needs an explicit client decision
  in `@meridian/thread-client`'s `src/turns/reduce-turn-event.ts` (apply,
  refetch, or ignore); otherwise the app renders an opaque unknown component.

Execution reports are one row per admitted child run, keyed by its first
reserved `executionTurnId`; steering may add assistant turns, and
`terminalTurnId` is set only at finalization. Capture and terminal writes are
idempotent compare-and-set operations. Publication is separate bookkeeping:
an admitted row does not imply a terminal result, and discovery retains pending
publication obligations while skipping deleted callers/projects. The report
lookup validates child handle, ownership, lineage, turn, and card in one root
repeatable-read snapshot; it selects the exact child-and-turn report, never the
latest report or a transcript tail.

The active-document resolver is the sole definition of documents relevant to a
thread: it unions explicit `thread_documents` attachments with documents
touched by turns, and the same definition drives active-thread notice fan-out
and retention. `threads.ai_write_mode` (`'direct'` | `'draft'`) is the chat's
mode: whether its AI edits wait in its Work's drafts or go live (D62). A chat
copies it at creation (`aiWriteMode`, else its Work's
`works.default_ai_write_mode`; subagents copy the parent, forks and handoffs
copy the source chat), and rebind, archive, and restore never change it.
Write-time routing reads the thread's mode over its current primary Work
(`threadExecutionContext`); `turns.ai_write_mode` records each reply's mode, and
the mode changes only between replies via the thread controls queue
(`POST /api/threads/:id/controls`, `{ kind: "write_mode" }`). Switching to
auto-apply applies nothing: pending drafts stay for review, and drafts carry
no push policy (D59). Branch review policy remains in
[collab](../../collab/.context/CONTEXT.md).

## Mutation lock order

The shared order is **in-process lease, thread row (`NO KEY UPDATE`),
participating Work rows sorted by id (`NO KEY UPDATE`), namespace/advisory keys,
then document locks**. `lockThreadAndWorks` stabilizes primary membership under
the thread lock before locking current and target Works together. Do not take a
Work lock first for a thread mutation, and do not acquire a thread lock from a
Work-only mutation. Runtime delivery takes its advisory lock before the thread
row; its long-lived run claim is outside the DB transaction.

Spawn, handoff, and fork lock the existing source thread before creating the
new row because the source journal is written in the same transaction. Work-only
mutations may enqueue immutable inbox markers while holding Work rows; the
thread FK's `KEY SHARE` does not conflict with `NO KEY UPDATE`.

Work lifecycle guards (`shared/work-lifecycle-lock.ts`): a mutation whose
validity depends on an active Work locks that Work row and rechecks lifecycle in
the same transaction, so delete cannot commit between authorization and the
dependent write. Stability guards (namespace and provisioning, membership,
authority reads) take `FOR KEY SHARE` and stay compatible with each other and
with activity updates; activity and projection mutations take `FOR NO KEY
UPDATE`; lifecycle transitions take `FOR UPDATE`. Namespace mutation has its own
exclusive guard. Derived threads take the stability guard after the source
thread lock and before allocating the handle counter. Work delete and purge
read the Work's chat forest, lock those threads, then the Work, and recheck, so
a chat that joined meanwhile retries rather than escaping the cascade. A durable
file write confirms its grants under the owning Work's row guard before any
advisory or document lock; project-owned and No Work files lock no Work row.
Named Work creation serializes handle minting through the project advisory lock.

## Ports and adapters

| Port | Contract |
|---|---|
| `ThreadRepository` | Lifecycle plus bounded writer-facing project lists and model summaries; get-by-id also returns subagents. |
| `ProjectChatFeedRepository` | Keyset pages of primary chats, filtering Work, Favorite, title, and archived state before pagination. |
| `ThreadUserStateRepository` | Per-writer Favorite authority. |
| `TurnRepository` | Turn creation, lookup, pending placeholders, status, and rollups. `findById` and `listByThread` return the conversation, without handed-back writer messages; the graph (`prevTurnId`, positions, leaf) is `turnGraph(turns)` from `ports/turn-graph.ts` ([hand-back](../../runtime/.context/delivery.md#leaving-the-chat-the-graph-and-the-conversation)). |
| `BlockRepository` | Create, upsert, replacement, and reads, all without handed-back writer messages' blocks; compaction elisions live in turn metadata, not block rows. |
| `ModelResponseRepository` | Response reads/writes, usage totals, cache-reset context. |
| `ThreadRepositories` | Repository aggregate plus atomic transactions and serialized turn-start transition. |
| `ThreadWorksRepository` | Membership history and primary reads; primary rebind demotes the old membership and preserves exactly one primary. |
| `rebindThreadWork` / `restoreOwnedThreadFromTrash` | Transaction-composable explicit rebind and authenticated restore boundaries. |
| `EventJournalWriter` / `EventJournalReader` | Append and cursor/type/time-range reads for `OrchestratorEvent` rows. |

Drizzle is the production adapter and in-memory adapters serve tests/dev. All
entity types and event unions are JSON-natural contracts in
`@meridian/contracts/threads`. Domains consuming this package must use these
ports rather than adapter details.

## Invariants

- `runTurnStartTransition` locks the thread, checks the expected active leaf,
  reconciles orphaned writes, projects the next turns, advances the leaf, and
  appends the journal event atomically. Cross-instance losers receive a typed
  conflict mapped to HTTP 409; do not map a generic unique violation to this
  result. In-memory transactions serialize through their transaction owner.
- Turn rollups and `threads.totalCostUsd` are recomputed atomically from
  `model_responses` by read-model projection. A later turn never rewrites an
  earlier terminal status, so an old failed reply remains `error`; whether it is
  current is a render-time decision.
- The owner-aware trash command is the only soft-delete/restore boundary. It
  locks the including-deleted row and revalidates thread and project ownership.
  Delete/restore are serialized; only a real restore enqueues the targeted
  Work-context notice. Missing, foreign, or concealed rows do not leak
  existence. A fully owned deleted thread has the attested `thread_deleted`
  response; WebSocket subscribe still conceals it as `not_found`.
- Project-scoped refs are allocated in the create transaction from one counter:
  primaries use `cN`, subagents `pN`. The grammar is shared in
  `@meridian/contracts/threads`; titles are not identifiers. Root create-or-get
  classifies an existing id before gating the requested project and never
  resurrects a deleted tombstone.
- `rootThreadId` is non-null and authoritative. Organic primaries and handoffs
  root at themselves; spawn and fork copy the source root. `sameLineage` uses
  root identity for background authority, while `isInSubtree` follows
  `parentThreadId` for foreground authority. Forks are siblings of their
  source; handoffs cross lineages. A missing root is an integrity error, not a
  mapper fallback: one stale descendant breaks `thread_ls`
  (`listLineageChildren`), `thread_message` authorization, Work purge's
  dependent-root retention, and trash restore's root-primary check, and the
  `(project_id, root_thread_id)` cascade FK would pull it into another
  conversation's deletion. A fork's up-edge is the owner of its cutoff turn
  (possibly inherited); a handoff's cutoff points to its source.
- `threads.active_leaf_turn_id` anchors the visible-conversation walk, and code
  that needs the latest turn reads it, never timestamp order: two turns created in
  the same millisecond are a normal production path. Hidden
  Work-context, inbox-message, compaction, and non-custom system turns are
  skipped; `subagent_update` and adopted inbox messages render inside the
  preceding assistant activity. Visibility keys on `metadata.kind`, not
  `origin`. `inbox_message` marks machine deliveries only; a writer send never
  carries it and stays a visible bubble. Keep the domain predicate, both SQL
  copies, and the view model's `classifyTurn` (`@meridian/thread-client`) in sync. `last_activity_at` and
  `conversational_leaf_turn_id` are written only by the database projection
  triggers; no repository recomputes them. This deliberately diverges from the
  database package's no-triggers rule, which protects columns with exactly one
  writer: this projection's risk is a future writer (branch switching) bypassing
  recompute, which only a trigger closes. A handed-back writer message
  (`thread_inbox_messages.handed_back_by`) never anchors the head or its preview:
  the function carries that predicate, and an `AFTER UPDATE OF handed_back_by`
  trigger recomputes the chat. A forgotten turn (`turns.forgotten_by_turn_id`)
  is never the head or preview either, and the lineage walks through forgotten
  assistants; an `AFTER UPDATE OF forgotten_by_turn_id` trigger recomputes.
  Readers apply a stamp only when the forgetting turn is inside the span they
  read (`inConversationSql(alias, throughPosition)`); the snapshot keeps
  forgotten turns, stamped `forgottenBy`, and the client hides them
  ([delivery](../../runtime/.context/delivery.md#forgetting-a-failed-attempt)).
- `actionRequired` is derived from the nearest assistant turn in the active
  lineage. A visible writer turn may be the head while an ancestor assistant is
  still parked on `waiting_interrupt`; that still needs the writer's answer.
  Draft-review action-required remains an extension point.
- `turns.origin` records authorship independently of `role` and has no column
  default: every create path sets it. Writer and assistant turns count for
  activity, while platform/agent system turns do not. Compaction, handoff, and
  reference seeds are system-origin turns; reply retries are assistant-origin
  and a manual compact command is a control, not a writer message.
- Project chat pages are keyset over `(lastActivityAt DESC, threadId DESC)`.
  The Work Chats tab is the Project feed with its Work filter set: the filter
  uses M:N membership history, while each row's Work identity is the current
  primary. Rows show the bound Agent's display name (`Subagent` when the
  binding has no revision). Chat lists have no read/unread state; only Favorite
  is persisted and opening a chat mutates nothing. Chat URLs use the
  client-minted thread `id`, not `ref`; refs are model- and dev-facing
  (`GET /api/projects/:projectId/threads/by-ref/:ref`), not writer-facing.
- Settled turns cannot gain new blocks; existing block content may be replaced
  (`block.updated` swaps a full custom block in place, never advances the active
  frontier or closes open segments, and rejects a missing block so a vanished
  card is not re-created).
  Orphan repair is the only path that settles a dead unsettled turn. Effective
  transcript pages resolve inherited owner-local spans by `(position, sequence)`
  under one repeatable-read snapshot; cursors pin the settled anchor.
- A complete compaction owns ordered `pinnedRequestTurnIds`, frozen elisions,
  and its bake boundary. Failed compactions have typed reason/phase metadata,
  writer copy, and no bake pointer. Undo markers are effective-transcript
  content: refused markers have no blocks or bake and do not alter projection.
  The active compaction is the latest complete one not reverted in the
  effective transcript, and a fork cutoff includes or excludes an undo marker
  with the rest of its prefix. `ThreadSnapshotResponse.compactionUndo` is null
  without an active local compaction or when the retained model left the
  catalog; `likely` availability is advisory, and missing bindings or corrupt
  metadata are invariant errors, not null.
- `thread_image_inclusions` is append-only: the latest decision by turn position
  wins, a fork copies the latest inherited decision at its cutoff, and source
  and fork decisions never mutate each other. Reads filter reverted compaction
  ids first, so pre-compaction exclusions can take effect again after undo.
- A spawned child's first user turn may carry a frozen `thread-reference` block;
  it stores source identity and model text and is not rewritten when the source
  changes. Writer admission cannot submit these blocks. `Thread.lastActivityAt`
  is conversation activity, not `updatedAt` (a retitle changes metadata only). The live `agent.spawn` event is a stream notification; the seed is
  the durable reference record.

## Compaction and transcript boundaries

Pending compaction turns reserve a position without a model or bake pointer.
Only a completed compaction sets `compaction_model`; its successor transaction
opens the write-once bake boundary and reserves the next control or reply.
The command is acknowledged when its start commits, not when the compaction
ends or the next reply responds. Success, failure, and cancellation settle
response rows and usage in their ending transaction. A live required-compaction failure also lands a terminal
failed reply and receipt atomically; only failure of that landing needs orphan
repair. Manual compaction controls hold no transcript position until execution.

`readTranscriptPage` resolves effective inherited history into owner-local
`(afterPosition, throughPosition]` spans without loading the transcript. It
reads selected turns and blocks under one repeatable-read snapshot, pages by
`(position, sequence)`, and pins the settled-prefix anchor in its cursor. A
newest-first page may include an unsettled-tail preview; when that preview fills
the page, the cursor restarts at the settled prefix. Complete bake boundaries,
including undo markers, open history segments. Inherited reads keep trashed
source owners available to a live fork and report `owners[].trashed`.

## Cross-domain dependencies

- `domains/runtime` consumes repository, journal, and hub ports for orchestration,
  delivery, compaction, and child runs.
- `server/lib` consumes ownership gates, snapshot building, and hub catchup for
  HTTP/WebSocket routes; it must not move thread policy into transport code.
- `@meridian/contracts` owns entity/event wire shapes. `@meridian/database/schema`
  owns the Postgres tables and functions. Collaboration branch/review policy
  remains in [`domains/collab`](../../collab/.context/CONTEXT.md).
