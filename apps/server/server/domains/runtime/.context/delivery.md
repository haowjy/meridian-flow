# Delivery: admission, inbox adoption, and wakes

This context covers how writer sends, machine messages, Work changes, and
notices become durable conversation. Model-visible mid-thread input is always a
turn at a graph point, never a live-request splice; the frozen prefix is in
[request assembly](request-assembly.md). Commands run only at run start under
[queue rules](controls.md), and a pending handoff seed is not an inbox row.
Rationale: the [one-run preparation protocol][kb-run-prep].

## Run identity

Three facts are server-decided, written once in the transaction that decides
them, and exposed on both the stream and the snapshot (`protocol/run-boundary.ts`
is the one reader). Clients merge them by union and never infer them from
transcript ancestry or stream order:

- **Membership.** An *execution* is one hold of the run lease
  (`thread_run_leases.execution_id`). Reservation sites write
  `turns.execution_id` and `turns.reserved_for_user_turn_ids` through
  `reservationTurn`. A Retry is reserved for its failed reply's list and records
  `metadata.retryOf` and `metadata.retryReplyId`. `RUN_STARTED.rawEvent` repeats
  `{ writeMode, executionId, reservedForUserTurnIds, position }`.
- **Delivery.** Every acknowledgement goes through the adapter's one `ack`:
  message rows it transitions record `delivered_by_turn_id` with `delivered_at`
  and journal `messages.delivered { byTurnId, byTurnPosition, executionId, userTurnIds }`.
  A yield, a cancelled compaction, and compaction orphan repair do not
  acknowledge, so a later execution takes the messages on.
- **End.** `endExecution` deletes the lease row and journals `execution.ended`
  when a turn carries the execution. Every live landing of an execution's last
  terminal turn ends it in that commit; `releaseExecution` unlocks when gone,
  ends when every reserved turn is terminal, or abandons (expires now, unlocks,
  journals nothing). `settleStaleExecution` runs under a newly acquired claim
  before inserting a new lease row.

## Selection and admission

`next(pending, at)` is the one selector used at run start and after release. At
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
(`metadata.delivery: "steer"`, returning `steersTurnId` as a Stop hint);
otherwise (idle, or behind a queued switch) it is stamped `send` and
`steersTurnId` is null. Expired reservations are reconciled under the shared
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
lock. One transaction consumes exactly the selected notices, persists the
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

Setup errors before adoption skip the immediate reread as the hot-loop guard;
short exclusive claim holders still rely on the wake sweep. A fork copies the
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
`inbox.changed`. Successful initial adoption clears it. The marker is projected
only while message/control work remains; notices alone do not sustain a block.
Balance restoration is retried by the ordinary wake sweep, not client polling.

[kb-run-prep]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/run-preparation-protocol.md
