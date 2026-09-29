# Delivery: admission, inbox adoption, and wakes

How a writer send, a subagent report, a Work change, or a notice becomes
durable conversation and reaches the model. Everything the model learns
mid-thread arrives here as a durable turn at a graph point, never as a
live-request splice; the frozen prefix it lands after is in
[request assembly](request-assembly.md). Compaction uses this inbox
but commands run only at the start of a run under the [queue rules](controls.md).
A pending handoff seed is not an inbox row. The detached brief holds the
destination run claim, so admission meets the claim rather than checking seed
state. Its release rereads the queue and starts pending work.
Rationale: [One Run Preparation Protocol][kb-run-prep].

## Command selection and release wake

`loop/next-inbox-work.ts` owns the pure `next(pending, at)` selector. At a
reply boundary it selects every non-command row, including rows and Work
refresh notices after a queued command; commands never run beside a tool call
or at turn close. At run start, every non-command row runs if any message is
waiting; otherwise the oldest command runs alone. Messages never wait behind a command.
A notice-only queue does not start a run, but a Work refresh notice already
waiting in the selected prefix at a reply boundary still closes that reply's
prefix. The selector returns at most one command per run. Stop only ends the
current turn; release then follows the same message-first rule.

After a run releases its claim, `wakeIfRunnable` refreshes pending state and
uses the same run-start selector as setup. It re-reads after runs that found no
work and after setup cancellation, so work enqueued while a claim was held is
not lost. A failed assistant acknowledges its adopted messages before release,
so neither the reread nor the periodic sweep replays that reply. The wake has no
failed-receipt exclusion: if the plain selector finds a queued command or other
work, it starts it. An empty reread cannot spin. Real setup errors before
adoption skip the reread as the hot-loop guard; short exclusive claim holders
still rely on the sweep.

## Writer admission

`UserTurnAdmission` owns writer replay, canonical fingerprinting, exact ordered text/reference/image parsing, project-final authorization with in-place text degradation for unavailable reference identity, lookup, and retirement. Admission is **validate → record → enqueue**: `admission/writer-turn-producer.ts` is the producer. It persists the writer's user turn + blocks at enqueue (reusing the inbox message id as the turn id), stamping any activated `/skill` slugs as hidden turn metadata for `prepareAdoptedTurn` to load when the turn is adopted; the delivery commit persists the hidden `system`-role skill-body turn immediately after it. It also appends the writer-provenance `message` in the same turn-start transaction, settling the admission ledger, upload consumption, and document attachment atomically; the wake is best-effort. Liveness is the runner map, never durable turn status: a mid-run send yields the runner's live assistant turn id (a crash-orphaned `streaming` turn and a `waiting_interrupt` run classify correctly), a fresh run yields null and the client learns the turn from `RUN_STARTED`. When a live assistant binding exists, the writer turn gets `metadata.delivery: "steer"` at enqueue; response grouping uses that stamp, not clock comparisons. The producer reads durable rows only as a fallback inside the runner's setup window, scoped to turns created after the run started. An admission winner rolls the whole turn-start transaction back instead of committing a losing or rejected submission.

A writer send is never an inbox delivery: `writer-enqueue.ts` persists the
writer's user turn with its own metadata (activated skill slugs or null) and no
`kind`, so it stays a visible bubble before and after adoption. Only machine
deliveries (an agent `thread_message`, other non-child messages) materialize
with `kind: "inbox_message"`, which hides them from the bubble list; the client
renders them as delivery rows inside the preceding assistant turn. Tagging a
writer turn `inbox_message` makes the writer's own message vanish once a run
drains it.

- **Writer enqueue preserves immutable graph order.** Before persisting a
  writer turn, materialize any older queued directed messages under the same
  inbox lock. Adoption can then reuse those durable IDs without reparenting
  history.
- **One running turn per thread.** Writer callers enter through
  `UserTurnAdmission`, whose replay lookup precedes the producer. An unseen
  identity is durably reserved, then the writer turn and inbox message commit
  in one turn-start transaction; a mid-run send merges at the run's next
  boundary instead of returning a busy conflict. `TurnRunner.startDrain`
  rejects a wake if a run is already active or being claimed for that thread.
  The PostgreSQL adapter also rejects same-process reentry because session
  advisory locks themselves are reentrant.
- **Expired writer admissions.** Lookup, replay, and retirement reconcile
  expired pending reservations through `UserTurnAdmission`. Recovery takes the
  runner's shared cross-process claim before the row-locking transaction and
  holds it through commit. Unexpired reservations do not contend for that
  claim. The ledger rechecks expiry and committed-turn evidence; an orphan
  settles to `recovery_no_committed_turn` without a model call or document
  effects.

## Prepare and commit

One `prepareAndCommit` protocol serves drain start and mid-run adoption. Direct
run input first persists the writer turn and matching inbox message under the
thread lock, then uses the drain-start path. The protocol selects pending IDs,
peeks notices, and reads the active leaf without the lock; prepares image
decisions, references, skills, and turn drafts without writes; then takes the
thread lock and validates the leaf and pending batch. A changed selection is
discarded and retried for at most three attempts; attempt three prepares under
the lock. One ambient transaction consumes exactly the selected notice IDs,
persists the first prompt bake and preparation effects, adopts the batch, and
reserves/binds the assistant. Preparation failure leaves notices queued but
adopts the writer batch and reserves the failed reply; the existing failure
finalizer acknowledges that batch. Cancellation discards preparation. Notice
IDs enter durable `system_update` history at the selected graph point, so
prefix bytes remain stable. Image decisions are append-only by deciding turn;
when a projection emits a break, its notice turn owns those decisions and
`turn.created` precedes them. A fork copies the latest decision at or before
its cutoff. Final close prepares only for pending messages or materializable
Work refreshes; after claim cleanup the common wake re-reads for waiting
messages or a queued command. The concrete Drizzle adapter appends the
classified pending replacement before commit; journal failure rolls back the
transition and only physical wake is best-effort after commit.

`loop/preparation-failure.ts` maps a preparation error to that reply's
writer-facing error. A failed reply stays `error`; its ending transaction
acknowledges every adopted inbox message. The read model never rewrites it when
the writer sends again. Explicit Retry starts a normal no-input run after the
failed turn; the ordinary request projection includes that turn. Pending
non-control rows are adopted normally, with no Retry-specific restoration or
inbox metadata. See the [reply Retry API](../../../../../../docs/api/thread-reply-retry.md).

- **Inbox adoption is lease-owned and transactional.** The current batch's
  exact IDs live in `thread_run_leases.adopted_message_ids`, never turn
  metadata. Binding a new assistant and recording its receipt commit with the
  graph split. Response persistence, inbox acknowledgement, and receipt
  clearing share one transaction. Successful and failed terminal replies
  acknowledge their receipt; cancellation acknowledges the receipt, not a
  later pending claim. The joined projection exposes `waiting` for an
  unadopted row behind a live bound run and `awaiting_run` for adopted rows or
  no bound live run. Generic `ThreadPendingInbox` projects every provenance;
  the app's `queuedWriterTurnIds` keeps writer rows in `waiting` so only those
  bubbles show Queued.

## Materializing a batch

Materializes a selected batch as durable turns/blocks. Caller-supplied notices and notice-intent inbox entries fold into one trailing `{ kind: "system_update", section: "notices" }` system turn built by `noticesTurnFor`/`formatNotices`; Work refreshes render to their own durable turn. Existing writer turns are adopted without a second append. `prepareAdoptedTurn` prepares missing text-reference reads and activated skill bodies, returning events and hidden sibling turns for the adoption transition -- never a block on the adopted turn itself, since anything that projects a user turn's text (`UserTurn.tsx`) concatenates every text block on it. `planMessageTurns` and `messageTurnFor` own fresh message history. Child completions persist a system turn with `{ kind: "subagent_update", handle, outcome, execution }` metadata; the execution UUID is for internal card correlation only. The shared context assembler renders from `turns`/`blocks` alone; never splice a second inbox rendering over the assembled request, which bypasses image authorization, model capability, and the whole-request occurrence budget.

Edit-intent notices, Work refreshes, and every other durable notice source
(`NoticePort`, non-message inbox entries) split the same way at the adoption
point. No notice source skips this split.

### Work context

Renders authoritative Work state. Mutations enqueue immutable system-provenance refresh notices in the business transaction. The delivery boundary coalesces a batch into one durable system update and event and acknowledges its notice IDs atomically. Idle recovery uses a short run claim; notices never wake a model.

A frozen prompt is never rebuilt for Work changes. Business mutations enqueue
immutable `work_context_refresh` inbox notices, including for hidden targets.
Running request boundaries and idle recovery render current authorized state
into one durable `<system_update>` user-role turn and `work_context.changed`
event, then ack the selected Work notice IDs in that same transaction. These
IDs are not response receipts. A running Work update closes A and starts B
under the same lease so replay remains causal. Writer enqueue and idle
delivery use one seq-ordered prefix materializer under the per-thread
transaction lock. Several pending mutations coalesce, while a racing mutation
retains its own unacked row. Hidden threads/projects and archived threads park
notices until restore; hard deletion cascades. Idle recovery uses
`RunClaim.withExclusiveThread` without a lease or model call. In-run Work
tools do not append history; the next request boundary does.

### Worked examples

What the model receives for five common deliveries, so "durable
`system_update` turn" and "merged into one message" stay concrete:

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

## References and images

Before the first model call, loads admitted current-turn text references through the host-wired shared agent-edit read operation; a mid-run adopted writer turn's unread references load at adoption. Reads run outside admission/persistence transactions; results are persisted server-side at `reference.read.result` before gateway submission. Duplicate `(documentId, uri)` identities read once per turn; replay reuses the frozen result, while a later mention reads afresh. Images retain their separate projection, and client admission rejects `read` payloads.

Late image bytes are identity-resolved after admission and read-deduplicated. `thread_image_inclusions` is append-only, keyed by `(thread_id, block_id, decision_turn_id)`; the latest row by turn position wins. A definite loss of a previously included asset creates an `asset_unavailable` break turn; a first-sight loss uses `asset_unavailable_first_sight` and does not break the already-sent prefix. Budget eviction of an included image creates its own named break. Transient resolution errors propagate to the failed-reply path without deciding the image. Projection applies the shared budget chronologically over history and adopted turns; compaction is the explicit seam for rebalance. Durable blocks retain only `image_reference` identity, never resolved bytes or inclusion state. The image-inclusion metadata codec lives with the other turn codecs in `threads/domain/turn-metadata.ts`. Compaction's re-admission pass is in
[compaction](compaction.md#image-re-admission).

## Locks and wakes

Short per-thread transaction serialization, distinct from the session run claim. Delivery acquires the advisory lock, then the shared `NO KEY UPDATE` thread row lock before enqueue or consumption/close. Work rows follow the thread row in sorted id order through `shared/thread-work-lock.ts`; publication parent locking and writer admission use the same order. Work-only notice insertion takes no thread mutation/advisory lock, only compatible FK `KEY SHARE`. No provider call runs under these locks. Thread visibility and turn transitions use `NO KEY
UPDATE` so a Work mutation holding Work rows can insert its marker with FK
`KEY SHARE` without a lock inversion.

The wake actuation seam. `createRunStarter` maps `RunStarter.start` to the turn runner's `startDrain`, handling `TurnStartConflictError` quietly and reporting unexpected failures once through EventSink because a wake is best-effort. `sweepWakes` is the durable recovery: it keyset-pages pending threads in stable thread-ID order, batch-reads live leases, and starts eligible threads with bounded concurrency. Its caller retains the returned cursor across sweeps; an empty suffix wraps to the first page. One candidate’s failure is reported without stranding the rest. `app.ts` registers the sweep with the process recovery scheduler at boot, then rearms it after completion with `WAKE_SWEEP_INTERVAL_MS` (default 30s). The `enqueue` wake is the latency path; the sweep is the guarantee.

[kb-run-prep]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/run-preparation-protocol.md
