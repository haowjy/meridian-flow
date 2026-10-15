# Delivery: admission, inbox adoption, and wakes

This context covers how writer sends, machine messages, Work changes, and
notices become durable conversation. Model-visible mid-thread input is always a
turn at a graph point, never a live-request splice; the frozen prefix is in
[request assembly](request-assembly.md). Commands run only at run start under
[queue rules](controls.md), and a pending handoff seed is not an inbox row.
Rationale: the [one-run preparation protocol][kb-run-prep].

## Run identity

Three facts are server-decided, written once in the transaction that decides
them, and exposed on the snapshot's turns (`RUN_STARTED` carries only `writeMode`).
Clients never infer them from transcript ancestry or stream order; `messageFate`
(`@meridian/thread-client`) reads them from one snapshot:

- **Membership.** An *execution* is one hold of the run lease
  (`thread_run_leases.execution_id`). Reservation sites write
  `turns.execution_id` and `turns.reserved_for_user_turn_ids` through
  `reservationTurn`. A Retry is reserved for its failed reply's list (its inbox
  rows are already acknowledged), carried as execution state through a
  start-time compaction to the first assistant, and records `metadata.retryOf`
  and `metadata.retryReplyId`. The
  reserved-for list is a hint, never proof; `Turn.position` orders an execution's turns.
- **Delivery.** Every acknowledgement goes through the adapter's one `ack`:
  message rows it transitions record `delivered_by_turn_id` with `delivered_at`.
  A yield, a cancelled compaction, and compaction orphan repair do not
  acknowledge, so a later execution takes the messages on. Delivery is the only
  "my message is done" fact; the snapshot joins it onto user turns
  (`Turn.delivery`). Controls and notices record none.
- **End.** One operation ends an execution: `RunClaim.release` deletes the lease
  row and, in the same transaction, marks the chat so the closed `RunState`
  (`execution: null`) is published with the turn write that ended it. No
  separate end event exists. Every live landing of an execution's last terminal
  turn ends it in that commit, including a compaction successor whose
  preparation failed (`commitAdoption` returns it `terminal`). The run owner's
  cleanup (`releaseExecution`) unlocks when the row is gone, ends when every
  reserved turn is terminal, or abandons (expires now, unlocks, publishes
  nothing). Ending, abandoning and stale settlement live in
  `adapters/execution-settlement.ts`; `settleStaleExecution` runs under a newly
  acquired claim before a new lease row is inserted
  ([recovery](recovery.md#settling-a-stale-lease)).

## Run state

One `RunState` per chat (`packages/contracts/src/threads/run-state.ts`): the
waiting inbox (`items`), `sentThrough`, the open `execution`, the applied write
`mode` and the usage `blocked` reason. It is a pure function of rows
(`loop/run-state.ts`, read by `adapters/drizzle-run-state.ts`), never of the
clock: the lease row counts whatever its expiry, and a turn must carry its
execution id for the execution to show.

- **Publication.** Every adapter method that writes an input (inbox rows, the
  lease row, `threads.inbox_blocked_reason`, a due switch's mode) marks the chat
  through `DeliveryStore.markRunStateChanged`, under the chat's thread lock; a
  mark without the lock, or after the flush, throws. A transaction participant
  appends one `run_state.changed` journal row per marked chat before commit, so
  a chat's last record follows its last input write. Savepoints fork the
  participant's state and merge on release. Work-context notices are not in the
  record and mark nothing.
- **Versions.** The `meridian.run_state` frame is the whole record at the stream
  version (`journalSeq * 1000`). The snapshot, the socket's `subscribed` state
  and command answers read the record at the journal head
  (`journalSeq * 1000 + 999`).
- **Answers.** Control and Retry answers carry `runState` from `answerRunState`
  under the thread lock: an unpublished change publishes first and answers at its
  stream version, otherwise it reads at the head. Admission carries only
  `runStateVersion`, stored in `user_turn_admissions.run_state_version` so a
  replay answers the same value.

## Stop and hand-back

`POST /api/threads/:id/stop` (`StopRequest`: `requestId`, `seenThrough`,
`seenExecutionId`, `mine`) is one chat command decided under the thread lock
from rows (`RuntimeDelivery.stop`, `loop/stop-rule.ts`). It cancels the open
execution and **hands back** the waiting writer messages no execution has taken
on; their content returns in the answer for the acting tab's composer. A message
is handed back or answered, never both: only if, under the lock, it is
undelivered and in no receipt (or in the receipt of a compaction this press
cancels, stripped of it in the same transaction). Adoption and `bindTurn`
validate under the same lock and refuse a flagged lease.

- **The rule** (`decideStop`, pure, judged on the facts before any write). P is
  the writer rows at or below `seenThrough` plus `mine`; L is the writer rows
  above it that are not `mine`. An execution *takes on* a message when it is in
  the lease receipt or one of its turns delivered it. The execution is cancelled
  when the writer saw it or it took on a message in P, unless it took on one in
  L. `decideHandBack` classifies each covered message as `gone` (another request
  handed it back), handed back, or `answered`.
- **`handBack`** is the same operation for the queue's x and Cancel queue: scope
  `ids` or `seen`, never cancels. Both write one `thread_hand_backs` row per
  request id in the request's transaction. **A replay returns that stored
  decision** with a fresh `runState` and flags nothing; the same id with another
  body is `HandBackConflictError` (409).
- **Applying a decision.** The hand-back row first (inbox rows reference it),
  then `inbox.ack` with `{ handedBackBy }`, the cancelled compaction's receipt
  strip, one `messages.handed_back` journal event, the usage-block clear, and
  `cancel_requested` on the lease row matched by execution id with no expiry
  predicate. The run session then aborts its own run when it holds the flagged
  execution; a replay never aborts a newer one.
- **Nothing is deleted.** The handed-back message's inbox row, turn and blocks
  stay for diagnostics.

### Leaving the chat: the graph and the conversation

The repository ports return the **conversation**: `TurnRepository.findById` and
`listByThread`, and every `BlockRepository` read, drop a handed-back writer
message and its blocks. The adapters own the SQL predicate
(`inConversationSql`, which also applies the forgetting stamp; `notHandedBackSql` stays for identity reads), which also guards transcript page keys, counts and ordinals,
`listMessageDeliveries`, `listLatestLocalRequesterText` and the chat-activity
projection. A reader that knows nothing about hand-back gets the safe read.

The **graph** (positions, `prevTurnId`, the leaf, fork cutoffs) still holds the
handed-back turn, because the leaf does not move and positions are unique per
chat. It is a separate read, `turnGraph(turns)`, exported only from
`threads/ports/turn-graph.ts`; Biome's `noRestrictedImports` lets only graph
modules, adapters, tests and contract suites import it. Add a module to that list
only when it walks `prevTurnId` or positions and filters its output. The
compaction projection drops a pin to a handed-back turn and resolves a cut at one
by position.

### Forgetting a failed attempt

Hand-back removes a message the writer took back. Forgetting removes an attempt
the writer abandoned or retried. It is one durable fact,
`turns.forgotten_by_turn_id`, written in the transaction that appends the turn
that retries the failure or moves the chat past it. Every transcript reader
filters it (`inConversationSql`), and a reader applies a stamp only if the
forgetting turn is inside the span it reads: a local read applies every stamp, a
fork or a paged cutoff only those at or before its last position. So a fork cut
before the move-on still sees the attempt, and one cut after inherits the
forgetting.

`decideForgetting` (`loop/forget-failed-attempt.ts`) is pure. It acts only when
the latest closing row (`loop/latest-row.ts`) is a settled failed reply or a
compaction, and never on a continuation (same execution id). A tool call in any
live member keeps the whole attempt. Retry forgets the failed reply and keeps
the writer's messages. Moving on also forgets the delivered writer messages when
every live member draws nothing (`replyDrawsNothing`, shared from
`@meridian/thread-client/view`), except messages a summary already protects. A
carried reply is never forgotten, and there is no backfill. Run start decides
first, hands the result to the append primitive as `expectedForgetting`, and the
primitive throws `ForgettingMismatchError` if the transaction would decide
differently. The journal gets `turns.forgotten` (`turnIds`, `byTurnId`, reason
`retried` or `forgotten`), which the client stamps on held turns.

A compaction that starts before it reaches the loop's cancel read still holds the
adopted message in its captured history, so `executeCompaction` reads the lease's
`cancelRequested` flag immediately before the summarizer call, through
`RunClaim.readOwned(lease)`: this execution's own row whatever its expiry,
because Stop flags an expired lease that is still held. The expiry-filtered
`read()` would report it asleep and let the handed-back message reach the
summarizer.

## Selection and admission

`next(pending, at)` is the one selector used at run start and after release. A
request boundary is the point between two model requests inside one execution. At
a request boundary it selects every non-command row, except when a message waits
behind a queued write-mode switch (`yield`: the execution ends with no
successor). At run start, pending non-command rows win unless a write-mode
switch precedes work (`switch`, applied at the admitted run start); a lone
switch stays pending, and otherwise the oldest command runs alone. See
[controls](controls.md). Stop ends only the current turn. A notice-only queue
does not start a run. `wakeIfRunnable` rereads after release and setup
cancellation; the periodic sweep is the durable backstop, and an empty reread
must not spin.

`UserTurnAdmission` is the writer fence under the thread lock. Its sequence is
**validate → record → enqueue**: replay/fingerprint identity is settled first,
then the writer turn, inbox message, activated-skill metadata, provenance,
admission ledger, upload consumption, and document attachments commit together.
Archiving the bound Work does not freeze its chats: sends, retries, and
interrupt answers remain admissible.
The writer turn remains visible and is never tagged as an inbox delivery. With a
live assistant binding and no queued write-mode switch it joins that reply
(`metadata.delivery: "steer"`); otherwise (idle, or behind a queued switch) it is
stamped `send`. The producer decides under the thread lock on every turn-start
attempt, reading the runner's live reply and the inbox. Admission answers the user
turn and `runStateVersion`, never a reply id: which reply answers a message comes
from [run identity](#run-identity). Expired reservations are reconciled under the shared
cross-process claim; an orphan with no committed turn gets
`recovery_no_committed_turn` without a model or document call.

Writer enqueue materializes older directed messages under the same inbox lock,
preserving immutable graph order. There is one running turn per thread:
replay precedes reservation, and `TurnRunner.startDrain` rejects an active or
being-claimed thread. A losing or rejected admission rolls back its whole
turn-start transaction.

## Prepare and commit

One `prepareAndCommit` protocol serves drain start and mid-run adoption. It
selects pending IDs, notices, the active leaf, references, skills, and images
without writes; then locks the thread and validates the selection. A changed
selection is discarded and retried at most twice before preparing under the
lock; a start whose selection holds a due write-mode switch prepares under the
lock at once, so the switch applies in the transaction that reserves the run. One transaction consumes exactly the selected notices, persists the
prompt bake and preparation effects, adopts the batch, and binds the assistant
(or pending compaction). Cancellation discards preparation; notices remain
queued. Journal append is in the same transaction as read-model projection and
physical wake is best-effort after commit.

A preparation error reserves a failed reply, preserves the specific cause in
metadata/details, acknowledges its adopted inbox batch, and leaves the read
model's failed turn intact. Explicit Retry is a normal no-input run using the
regular history; it does not restore inbox provenance. Inbox receipt membership
lives in `thread_run_leases.adopted_message_ids`, not turn metadata. Binding,
response persistence, acknowledgement, receipt clearing, and terminal lease
release are transactionally paired. Orphan recovery never retires a receipt
whose selector names a terminal turn.

Setup errors before adoption skip the immediate reread as the hot-loop guard. A
short exclusive claim (`hold` or `withExclusiveThread`) that turned another start
away wakes its chat on release (`loop/contended-claim-wake.ts`); that tracking is
per process, so when another server process holds the claim the periodic sweep
recovers the work. A fork copies the
latest image decision at or before its cutoff.

## Materialized context

The adoption boundary renders caller-supplied notices into one trailing
`system_update` turn and Work refreshes into their own durable turn. Existing
writer turns are adopted without a second append; machine messages use
`inbox_message` provenance. Activated skill bodies become hidden sibling system
turns, never blocks on the writer turn. Child completions carry body-free
`subagent_update` metadata; the parent reads the report through a tool.

Work context contains only the bound Work's name, archive state, status, and
bounded goal. Mutations enqueue immutable refresh notices in the business
transaction; delivery coalesces selected notices and acknowledges them with the
rendered system update. Running Work changes close A and start B under one
lease. In-run Work tools do not append history. Hidden or archived targets park
notices until restore; hard deletion cascades.

## References, images, and synchronization

Current-turn text references load outside admission transactions and persist
server-side evidence before gateway submission. Duplicate document identities
read once per turn; replay reuses frozen results. Image inclusion decisions are
append-only by deciding turn, resolved late, and projected chronologically;
definite loss or budget eviction creates a named break, while first-sight loss
does not rewrite an already-sent prefix. Blocks retain identity, never bytes or
inclusion state.

Delivery takes the per-thread advisory/row lock and orders Work rows before
thread mutation. No provider call runs under those locks. The process-local
enqueue wake is the latency path; keyset-paged `sweepWakes` is the recovery
guarantee.

## Credit blocking

When a drain claim cannot pass `canStartTurn`, delivery records
`credits_exhausted` under the thread lock with a held, unbound claim and emits
the change in the run-state record, whose `blocked` carries it. Successful
initial adoption clears it. The marker is projected
only while message/control work remains; notices alone do not sustain a block.
Balance restoration is retried by the ordinary wake sweep, not client polling.

[kb-run-prep]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/run-preparation-protocol.md
