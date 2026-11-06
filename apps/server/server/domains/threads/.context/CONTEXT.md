# domains/threads — thread persistence & event spine

Owns durable threads, turns, blocks, model responses, and the event journal that
feeds AG-UI clients. Threads use `thread_works` for Work membership: exactly one
primary membership is active, and No Work is a real Work row.

## Creation and derivation

Policy is in [fork and handoff][kb-derivation]. `SubagentThreadFactory` is the only
subagent creation boundary.

- An existing row answers a fork or handoff id as create-or-get only when owner,
  project, `originType` and `kind = primary` all match; any other row conflicts. The
  match never reads journal events.
- `threads.origin_turn_id` is `ON DELETE NO ACTION`: provenance is never nulled to let
  a source turn be deleted. Work purge keeps a deleted Work whose turns another Work's
  fork or handoff still inherits.
- `threads.derivation_source_thread_id` records the chat the writer acted on,
  independently of the cutoff owner; it is not a spawn-parent relationship.

## Prompt lifetime

Immutable bytes live in `prompt_bakes`; `threads.initial_prompt_bake_id` is
write-once, and `turns.prompt_bake_id` marks later epoch boundaries. Database triggers
reject bake updates and deletes except owner-thread cascades, and reject pointer
changes after the first non-null value. `findCutoffOwnerThreadId` is the only
cutoff-owner lookup; callers don't walk parent turns themselves. Advertised tools are
untyped `jsonb` here because the runtime owns their shape.

Raw provider causes stay in diagnostics, logs and `./mf`, while `turn.error` stores
writer copy. A failed reply's metadata carries `reason`, the gateway's `retryable`
verdict and `providerError` as debug evidence only: a non-retryable verdict renders as
a provider-declined block but never blocks a writer's explicit Retry, and provider
text never enters event logs.

## Durable state and event spine

- Snapshot `threadUsage` carries raw totals. `inputTokens` includes cache reads and
  writes, and only calls whose provider reported cache counters enter the hit-rate
  denominator.
- Work deletion marks live primary chats and descendants with `deletedByWorkId` in the
  same transaction; independently trashed chats are not marked, and a cascaded chat
  can't be restored until its Work is.
- `threads.status` is lifecycle-only. Run liveness is read from the lease alone, and
  the snapshot's `liveState.runState` is the chat's whole `RunState` record
  ([run state](../../runtime/.context/delivery.md#run-state)).
- The thread snapshot builder reads rows, live state, watermark and journal head in
  one root repeatable-read view. `messageFate` reads a user turn's absence from that
  snapshot as a hand-back, so a snapshot that hides turns any other way has to expose
  `handedBackIds`.
- `ThreadEventHub` is process-local pub/sub and a bounded hot cache over the durable
  journal. Catchup installs a guard listener, replays, then merges buffered live events
  without gaps. Replay older than the cache seeks to the last projector reset strictly
  before the cursor's journal row, then projects the suffix: terminal rows reset the
  projector, and seeking into a reply without reconstructing it would change message
  ids and frame sub-indexes. Cold initialization captures a journal head, builds a
  private projector after the last reset at or before it, then publishes projector,
  cache and cursor together, so a failed bootstrap leaves no partial state. Client
  cursors are journal `seq` times 1000 (`EVENT_SEQ_FACTOR`) so one journal entry can
  project several AG-UI events; sequence gaps from rolled-back allocations are legal.
  Finished reply transport rows are pruned in the journal transaction after the next
  reply finishes; the newest finished reply remains available for reconstruction. A
  cursor below that retained boundary gets a replay gap so the client reloads its
  snapshot instead of silently losing stream frames. Projected rows and
  `run_state.changed` rows are not part of this retention rule.
- Every custom event name the orchestrator projector emits needs an explicit client
  decision in `@meridian/thread-client`'s `src/turns/reduce-turn-event.ts` (apply,
  refetch or ignore); otherwise the app renders an opaque unknown component.
- The active-document resolver is the sole definition of documents relevant to a
  thread: explicit `thread_documents` attachments plus documents touched by turns. The
  same definition drives active-thread notice fan-out and retention.
- Write-time routing reads the thread's mode over its current primary Work
  (`threadExecutionContext`).

## Mutation lock order

The shared order is **in-process lease, thread row (`NO KEY UPDATE`), participating
Work rows sorted by id (`NO KEY UPDATE`), namespace/advisory keys, then document
locks**. `lockThreadAndWorks` stabilizes primary membership under the thread lock
before locking current and target Works together. Don't take a Work lock first for a
thread mutation, and don't acquire a thread lock from a Work-only mutation: either
inverts turn persistence's thread-then-Work order. Runtime delivery takes its advisory
lock before the thread row; its long-lived run claim is outside the DB transaction.

Spawn, handoff and fork lock the existing source thread before creating the new row
because the source journal is written in the same transaction. Work-only mutations may
enqueue immutable inbox markers while holding Work rows; the thread FK's `KEY SHARE`
doesn't conflict with `NO KEY UPDATE`.

Work lifecycle guards: a mutation whose validity depends on an active Work locks that
Work row and rechecks lifecycle in the same transaction, so delete can't commit
between authorization and the dependent write. Stability guards (namespace and
provisioning, membership, authority reads) take `FOR KEY SHARE` and stay compatible
with each other and with activity updates; activity and projection mutations take
`FOR NO KEY UPDATE`; lifecycle transitions take `FOR UPDATE`. Namespace mutation has
its own exclusive guard. Derived threads take the stability guard after the source
thread lock and before allocating the handle counter. Work delete and purge read the
Work's chat forest, lock those threads, then the Work, and recheck, so a chat that
joined meanwhile retries rather than escaping the cascade. A durable file write
confirms its grants under the owning Work's row guard before any advisory or document
lock; project-owned and No Work files lock no Work row. Named Work creation serializes
handle minting through the project advisory lock.

## Contracts

- `runTurnStartTransition` cross-instance losers receive a typed conflict mapped to
  HTTP 409. Don't map a generic unique violation to this result.
- A later turn never rewrites an earlier terminal status, so an old failed reply
  remains `error`; whether it is current is a render-time decision.
- The owner-aware trash command is the only soft-delete/restore boundary. Missing,
  foreign or concealed rows don't leak existence. A fully owned deleted thread gets the
  attested `thread_deleted` response; WebSocket subscribe still conceals it as
  `not_found`. Delete and archive end the chat's run, asks and subagent subtree inside
  the delete or archive transaction, before taking the thread row lock (`stopThreads`, see
  [spawn](../../runtime/.context/spawn.md)).
- `rootThreadId` is non-null and authoritative. Organic primaries and handoffs root at
  themselves; spawn and fork copy the source root. A missing root is an integrity
  error, not a mapper fallback: one stale descendant breaks `thread_ls`
  (`listLineageChildren`), `thread_message` authorization, Work purge's dependent-root
  retention and trash restore's root-primary check, and the
  `(project_id, root_thread_id)` cascade FK would pull it into another conversation's
  deletion.
- Code that needs the latest turn reads `threads.active_leaf_turn_id`, never timestamp
  order: two turns created in the same millisecond are a normal production path.
- Visibility keys on `metadata.kind`, not `origin`
  ([why][kb-system-updates]). Keep the domain predicate, the SQL copies in `adapters/drizzle/transcript-reader.ts` and
  `turn-repository.ts`, and the view
  model's `classifyTurn` (`@meridian/thread-client`) in sync.
- `last_activity_at` and `conversational_leaf_turn_id` are written only by database
  projection triggers; no repository recomputes them. This departs from the database
  package's no-triggers rule, which protects columns with exactly one writer: this
  projection's risk is a future writer (branch switching) bypassing recompute, which
  only a trigger closes. A handed-back writer message or a forgotten turn never anchors
  the head or its preview; `AFTER UPDATE` triggers on `handed_back_by` and
  `forgotten_by_turn_id` recompute the chat.
- Readers apply a forgetting stamp only when the forgetting turn is inside the span
  they read (`inConversationSql(alias, throughPosition)`). The snapshot keeps forgotten
  turns, stamped `forgottenBy`, and the client hides them
  ([delivery](../../runtime/.context/delivery.md#forgetting-a-failed-attempt)).
- `block.updated` swaps a full custom block in place, never advances the active
  frontier or closes open segments, and rejects a missing block so a vanished card is
  not re-created. Orphan repair is the only path that settles a dead unsettled turn.

[kb-derivation]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/conversations/fork-and-handoff-derivation.md
[kb-system-updates]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/system-update-notification-framework.md
