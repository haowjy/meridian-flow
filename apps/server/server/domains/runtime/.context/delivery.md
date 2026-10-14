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

## Run identity

Three facts are server-decided, written once in the transaction that decides
them, and exposed on both the stream and the snapshot (`protocol/run-boundary.ts`
is the one reader). Clients merge them by union and never infer them from
transcript ancestry or stream order.

- **Membership.** An *execution* is one hold of the run lease
  (`thread_run_leases.execution_id`). Both reservation sites (run start in
  `orchestrator.ts`, split and compaction successor in `commitAdoption`) write
  `turns.execution_id` and `turns.reserved_for_user_turn_ids` (the selection's
  outstanding messages) through `reservationTurn`. A Retry is reserved for its
  failed reply's list, carried as execution state (those inbox rows are already
  acknowledged) through a start-time compaction to the first assistant; its
  first reservation records `metadata.retryOf` and `metadata.retryReplyId`.
  `RUN_STARTED.rawEvent` repeats `{ writeMode, executionId,
  reservedForUserTurnIds, position }`. The reserved-for list is a hint, never
  proof; `position` (`Turn.position`) orders an execution's turns.
- **Delivery.** Every acknowledgement goes through the adapter's one `ack`:
  message rows it actually transitions record `delivered_by_turn_id` with
  `delivered_at` and journal one `messages.delivered { byTurnId,
  byTurnPosition, executionId, userTurnIds }`. Deliverers: response persistence (`ackWithResponse`, the
  current assistant), a failed or cancelled assistant's close, a terminal
  placeholder, a failed successor, assistant orphan repair. A child run's
  pre-reservation abort delivers with no turn. Controls and notices record
  none. A yield, a cancelled compaction and a compaction's orphan repair do not
  acknowledge, so a later execution takes the messages on. Delivery is the only
  "my message is done" fact; the snapshot joins it onto user turns
  (`Turn.delivery`).
- **End.** `endExecution` replaces every in-transaction release: it deletes the
  row and journals `execution.ended` only when some turn carries the
  execution, so an execution that reserved nothing is never observable. Every
  live landing of an execution's last terminal turn ends it in that commit: a
  close, a terminal placeholder or yield, and a compaction successor whose
  preparation failed (`commitAdoption` returns it `terminal`, so the run exits
  without a second landing). The
  run owner's cleanup calls `releaseExecution`: unlock only when the row is
  gone, end when every reserved turn is terminal, otherwise **abandon**
  (expire the row now, unlock, journal nothing). Ending, abandoning and stale
  settlement live in `adapters/execution-settlement.ts`; delivery keeps selection,
  preparation, switches, reservation, hand-back and Stop. `settleStaleExecution` runs
  under a newly acquired claim before anything else (inside `startExecution`
  before the new row is inserted, and in `materializeIdle`
  and the repair lane, which also scans expired lease rows): repairs commit
  first, then the end append and the row delete are one transaction. The end
  is decided from turns carrying the id, never from the row's receipt arrays,
  which repair clears. The snapshot reads `liveState.openExecutionId` inside its
  own transaction, regardless of expiry: an execution on a snapshot turn that
  is not open has ended. The WS `subscribed` state does not carry it.

## Run state: the record and its publication

One `RunState` per chat (`packages/contracts/src/threads/run-state.ts`) says what the chat is doing:
its waiting inbox (`items`), `sentThrough`, the open `execution`, the applied write `mode` and the
usage `blocked` reason. It is a pure function of rows (`loop/run-state.ts`, read by
`adapters/drizzle-run-state.ts`), never of the clock: the lease row counts whatever its expiry, and a
turn must carry its execution id for the execution to show.

- **Publication.** A transaction participant appends one `run_state.changed` journal row for every chat
  marked changed, before the transaction commits, so a chat's last record follows its last input write.
  Every adapter method that writes an input (inbox rows, the lease row, `threads.inbox_blocked_reason`,
  and `applyDueSwitch`'s mode through `DeliveryStore.markRunStateChanged`) marks the chat, under the
  chat's thread lock. A mark without the lock, or after the flush, throws. Savepoints fork the
  participant's state and merge it back on release, so a rolled-back lock or mark disappears with it.
  Work-context notices are not in the record and mark nothing. Releasing a lease row no turn carries
  and that bound nothing changes nothing, so it marks nothing.
- **Versions.** The stream frame `meridian.run_state` is the whole record; the hub stamps its own seq
  (`journalSeq * 1000`) on it, live and on replay. The snapshot, the socket's `subscribed` state and
  command answers read the record with the journal head (`journalSeq * 1000 + 999`).
- **Answers.** Control and Retry answers carry `runState` from `answerRunState` under the thread
  lock: if the transaction has an unpublished change it publishes first and answers with that record at
  its stream version; otherwise it reads at the head, head last. The admission carries only
  `runStateVersion` (the stream version of the record its own transaction published), stored in
  `user_turn_admissions.run_state_version` so a replay answers the same value. Rows from before the
  column answer `null`.
- **Transitional.** `inbox.changed` and the old answer fields still ship beside the record until the
  app moves onto it. A hand-back also appends `inbox.changed`.

## Stop and hand-back

`POST /api/threads/:id/stop` (`StopRequest`: `requestId`, `seenThrough`, `seenExecutionId`, `mine`) is one
chat command decided under the thread lock from rows (`RuntimeDelivery.stop`, `loop/stop-rule.ts`). It
cancels the open execution and **hands back** the waiting writer messages no execution has taken on;
their content comes back in the answer for the acting tab's composer. A message is either handed back or
answered, never both: a message is handed back only if, under the lock, it is undelivered and in no
receipt (or in the receipt of a compaction this same press cancels, which is stripped of it in the same
transaction). Adoption and `bindTurn` validate under the same lock and refuse a flagged lease.

- **The rule** (`decideStop`, pure, judged on the facts before any write). P is the writer rows at or
  below `seenThrough` plus `mine`; L is the writer rows above it that are not `mine`. An execution
  *takes on* a message when it is in the lease receipt or one of its turns delivered it. E (the lease
  row, expiry ignored, when a turn carries its id) is cancelled when the writer saw it or it took on a
  message in P, unless it took on a message in L. `decideHandBack` classifies each covered message:
  `gone` (another request handed it back), hand back (undelivered, in no receipt, or in a cancelled
  compaction's receipt), otherwise `answered`.
- **`handBack`** is the same operation for the queue's x and Cancel queue (Q adds their route): scope
  `ids` or `seen`, never cancels. Both write one `thread_hand_backs` row per request id in the request's
  transaction (fingerprint of the body, `handed_back` / `answered` / `gone`, `cancelled_execution_id`).
  **A replay returns that stored decision**, the handed-back messages' content read from their turns, and
  a fresh `runState`; it flags nothing. The same id with another body is `HandBackConflictError` (409).
  `gone` for a `seen` scope covers every row at or below `seenThrough` that another request handed back, however old.
- **Applying a decision.** The hand-back row first (inbox rows reference it), then `inbox.ack` with
  `{ handedBackBy }` (delivered, no deliverer), the cancelled compaction's receipt strip, one journal
  event `messages.handed_back { userTurnIds, requestId }`, the usage-block clear, and `cancel_requested`
  on E's row matched by execution id with no expiry predicate. The run session then aborts its own run
  when it holds the flagged execution; a replay never aborts a newer one.
- **Nothing is deleted.** The handed-back message's inbox row, turn and blocks stay for diagnostics.

### Leaving the chat: the graph and the conversation

The repository ports return the **conversation**: `TurnRepository.findById` and `listByThread`, and every
`BlockRepository` read, drop a handed-back writer message and its blocks. The adapters own the one SQL
predicate (`notHandedBackSql`), which also guards the transcript page keys, the count and ordinal SQL,
`listMessageDeliveries`, `listLatestLocalRequesterText` and the chat-activity projection (`0049`). A reader
of content that knows nothing about hand-back gets the safe read.

The **graph** (positions, `prevTurnId`, the leaf, fork cutoffs) still holds the handed-back turn, because the
leaf does not move: positions are unique per chat and allocated from it. It is a separate read,
`turnGraph(turns)` (`listByThread`, `findById`, `latest`), exported only from
`threads/ports/turn-graph.ts`. Biome's `noRestrictedImports` (`biome.json`) lets only the graph modules,
adapters, tests and contract suites import that file, so an unlisted module cannot compile into the graph.
Add a module to the override list only when it walks `prevTurnId` or positions and filters its output:
`loadThreadConversationContext` (resolves forks and cutoffs on the graph, filters last), run start and
`inbox-context` (the leaf), `run-session` (Retry's leaf and the switch walk), the snapshot, transcript-page
cutoffs, the handoff brief's leaf, `thread-ls` and readable-thread origin lookups. The compaction projection
drops a pin to a handed-back turn and resolves a cut at one by position (`resolveCut`).

A compaction that starts before it reaches the loop's cancel read still holds the adopted message in its
captured history. `executeCompaction` reads the lease's `cancelRequested` flag immediately before the
summarizer call: a Stop on another server sets it in the transaction that hands the message back.
`stop-protocol.db.test.ts` row 37 pins the port defaults and row 14 the ordering.

## Command selection and release wake

`loop/next-inbox-work.ts` owns the pure `next(pending, at)` selector. A
**request boundary** is the point between two model requests inside one
execution (one run; see [run identity](#run-identity)). At a request boundary the selector
takes every non-command row, including rows and Work refresh notices after a
queued command; commands never run beside a tool call or at turn close. At run
start, every non-command row runs if any message is waiting; otherwise the
oldest command runs alone. Messages never wait behind a command, except behind
a queued write-mode switch: then a request boundary returns `yield` (the execution
ends there with no successor) and run start returns `switch` when something else will run (applied
at the admitted run start); a lone switch stays pending. See [controls](controls.md) for the
table, the yield and cancel-out. A notice-only queue does not start a run, but
a Work refresh notice already waiting in the selected rows at a request
boundary still closes that execution's batch. The selector returns at most one
command per run. Stop only ends the current turn; release then follows the
same rule.

After a run releases its claim, `wakeIfRunnable` uses the same run-start selector as
setup; a due write-mode switch applies inside the admitted run start
(`selectRunStart`), never in the wake. It re-reads after runs that found no
work and after setup cancellation, so work enqueued while a claim was held is
not lost. A failed assistant acknowledges its adopted messages before release,
so neither the reread nor the periodic sweep replays that execution. The wake has no
failed-receipt exclusion: if the plain selector finds a queued command or other
work, it starts it. An empty reread cannot spin. Real setup errors before
adoption skip the reread as the hot-loop guard. A short exclusive claim (`hold`
or `withExclusiveThread`) that turned another start away wakes its chat when it
releases (`loop/contended-claim-wake.ts`, wrapped around the run claim at
composition). That tracking is per process: when the claim is held by another
server process, the periodic sweep is what recovers the work.

## Writer admission

The bound Work must exist, but archiving does not freeze its chats: sends,
retries, and interrupt answers remain admissible. The admission fence runs
under the thread lock before writer-turn persistence.

`UserTurnAdmission` owns writer replay, canonical fingerprinting, exact ordered text/reference/image parsing, project-final authorization with in-place text degradation for unavailable reference identity, lookup, and retirement. Admission is **validate → record → enqueue**: `admission/writer-turn-producer.ts` is the producer. It persists the writer's user turn + blocks at enqueue (reusing the inbox message id as the turn id), stamping any activated `/skill` slugs as hidden turn metadata for `prepareAdoptedTurn` to load when the turn is adopted; the delivery commit persists the hidden `system`-role skill-body turn immediately after it. It also appends the writer-provenance `message` in the same turn-start transaction, settling the admission ledger, upload consumption, and document attachment atomically; the wake is best-effort. Liveness is the runner map, never durable turn status (a crash-orphaned `streaming` turn and a `waiting_interrupt` run classify correctly). Under the thread lock, on every turn-start attempt, the producer decides which reply the message joins, reading both the runner's live reply and the inbox there (a reply that ended, or a switch that applied, before the lock is visible): with a live assistant binding and no queued write-mode switch it joins that reply, is stamped `metadata.delivery: "steer"`, and admission returns that reply as `steersTurnId`, a Stop hint only; otherwise (idle, or behind a queued switch, which ends the reply instead) it is stamped `send` and `steersTurnId` is null. Which reply answers the message is never inferred from admission or stream order: it comes from [run identity](#run-identity). The stamp and the returned id come from that one decision and cannot disagree. Response grouping uses that stamp, not clock comparisons. The producer reads durable rows only as a fallback inside the runner's setup window, scoped to turns created after the run started. An admission winner rolls the whole turn-start transaction back instead of committing a losing or rejected submission.

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

`loop/preparation-failure.ts` maps a preparation error to its diagnostic
`MeridianError`; the terminal finalizer derives the stored generic copy from
the turn's role and keeps the specific cause in error details and metadata. A
failed reply stays `error`; its ending transaction
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
  later pending claim. A path that writes the run's last terminal turn also
  releases its lease in that transaction; orphan recovery never retires a
  receipt whose selector names a terminal turn
  ([recovery](recovery.md#settling-a-stale-lease)). The joined projection exposes `waiting` for an
  unadopted row behind a live bound run and `awaiting_run` for adopted rows or
  no bound live run. The run-state record lists every provenance;
  the package's `waitingWriterMessages` keeps writer rows in `waiting` so only
  those bubbles show Queued.

## Materializing a batch

Materializes a selected batch as durable turns/blocks. Caller-supplied notices and notice-intent inbox entries fold into one trailing `{ kind: "system_update", section: "notices" }` system turn built by `noticesTurnFor`/`formatNotices`; Work refreshes render to their own durable turn. Existing writer turns are adopted without a second append. `prepareAdoptedTurn` prepares missing text-reference reads and activated skill bodies, returning events and hidden sibling turns for the adoption transition -- never a block on the adopted turn itself, since anything that projects a user turn's text (`UserTurn.tsx`) concatenates every text block on it. `planMessageTurns` and `messageTurnFor` own fresh message history. Child completions persist a system turn with `{ kind: "subagent_update", handle, outcome, execution }` metadata; the execution UUID is for internal card correlation only. The shared context assembler renders from `turns`/`blocks` alone; never splice a second inbox rendering over the assembled request, which bypasses image authorization, model capability, and the whole-request occurrence budget.

Edit-intent notices, Work refreshes, and every other durable notice source
(`NoticePort`, non-message inbox entries) split the same way at the adoption
point. No notice source skips this split.

### Empty and canceled notice batches

Notice selection and acknowledgement do not imply a history turn. The shared
inbox planner formats the batch first and appends a notices turn only for
non-whitespace content; canceled or empty notices are still consumed in the
adoption transaction and do not themselves split a running reply. Writer
reversal notices must retain redo records: an undo/redo pair before delivery
cancels for that document URI and write handle. An undo alone reports unwanted
edits; a redo arriving after an earlier batch reports restored edits. Other
notice sections survive reversal cancellation.

### Work context

Renders only the bound Work: name, archive state, free-text status, and a goal
bounded to 2,000 characters with paragraph breaks preserved. Other Works are
discovered through `work list`, not embedded in context. Updates notify only
threads primarily bound to the changed Work; creation and deletion enqueue no
refresh. Mutations enqueue immutable system-provenance refresh notices in the
business transaction. The delivery boundary coalesces a batch into one durable system update and event and acknowledges its notice IDs atomically. Idle recovery uses a short run claim; notices never wake a model.

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
   current: drafting: "Drafting"
     goal: |
       Land the reveal in ch. 12.
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
   a user turn) never renders it. Its block text, for a packaged skill, carries
   the same header as `skill()`:
   ```
   <system_update>
   skills://writing-principles/SKILL
   Paths in this skill are relative to skills://writing-principles/.

   description: Craft rules for revision

   Show, do not tell.
   </system_update>
   ```
   An account-install skill has no files, so its first line is
   `skill invoked: <slug>` instead (`loop/activated-skills.ts`).

Every one of these five is either a `system`-role turn with no custom block
(2, 4, 5) or a `user`-role turn carrying one of the specific hidden-metadata
shapes above (1 is genuinely visible; 3 is not). `visible-conversation-policy.ts`
and the view model's `classifyTurn` (`@meridian/thread-client`) keep every hidden one out of the chat
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

## A start waiting for usage

`prepareLoop` asks RuntimeDelivery to save `credits_exhausted` when a drain
claim cannot pass `canStartTurn`. Delivery alone sets and clears the thread's
`inbox_blocked_reason`: under the thread lock with a held, unbound claim, and
in the same transaction as `inbox.changed`. A successful initial adoption
clears it with binding the first turn. Every inbox retirement goes through the
shared acknowledgement helper, which clears the marker when no message/control
remains (notices alone cannot sustain a block). Empty-inbox refused wakes never
install one. A failed publication rolls back the acknowledgement and clear.
Repeated refused wakes do not republish an unchanged block.

The run-state record's `blocked` is `{ reason: "credits_exhausted" }` only
while message/control work remains pending. Snapshots, socket subscription
state and `meridian.run_state` carry the same record. The ordinary
server wake sweep retries after balance restoration; clients add no polling.
The accepted writer turn remains saved, with no failed assistant placeholder.
