# Delivery: admission, inbox adoption, and wakes

How writer sends, machine messages, Work changes and notices become durable
conversation. Policy is in [the delivery boundary and run claim][kb-delivery] and
[run preparation][kb-run-prep]; commands follow [controls](controls.md).

## Run identity

The membership, delivery and end facts are in [run identity][kb-run-identity].
Reservation sites write `turns.execution_id` and `turns.reserved_for_user_turn_ids`
through `reservationTurn`. A Retry's reserved-for list is execution state carried
through a start-time compaction to the first assistant. Every acknowledgement goes
through `ack` in `adapters/execution-settlement.ts`; a yield, a cancelled compaction
and compaction orphan repair don't acknowledge, so a later execution takes the
messages on.

## Run state

`RunState` is a pure function of rows (`loop/run-state.ts`), never of the clock
([run-state record][kb-run-state]).

- **Publication.** A method that writes an input of the record (inbox rows, the
  lease row, `threads.inbox_blocked_reason`, a due switch's mode) marks the chat
  through `DeliveryStore.markRunStateChanged` under its thread lock. A transaction
  participant then appends one `run_state.changed` journal row per marked chat
  before commit. A write that skips the mark leaves clients on a stale record.
  Work-context notices are not in the record and mark nothing.
- **Versions.** The `meridian.run_state` frame is the whole record at the stream
  version (`journalSeq * 1000`). The snapshot, the socket's `subscribed` state and
  command answers read the record at the journal head (`journalSeq * 1000 + 999`).
- **Answers.** Control and Retry answers carry `runState` from `answerRunState`
  under the thread lock. Admission carries only `runStateVersion`, stored in
  `user_turn_admissions.run_state_version` so a replay answers the same value.

## Stop and hand-back

The rule is [Stop hands waiting messages back][kb-stop]: `loop/stop-rule.ts`
decides and `adapters/thread-commands.ts` applies. Adoption and `bindTurn` validate
under the same thread lock and refuse a flagged lease, so a message is handed back
or answered, never both. `cancel_requested` is set on the lease row matched by
execution id with no expiry predicate, so a replay never aborts a newer execution.

`executeCompaction` reads `cancelRequested` immediately before the summarizer call
through `RunClaim.readOwned(lease)`: this execution's own row whatever its expiry,
because Stop flags an expired lease that is still held. The expiry-filtered `read()`
would report it asleep and let a handed-back message reach the summarizer.

From Send now, `cancelledExecutionId: null` means this attempt requested no
cancellation and says nothing about the reply's fate; a 200 confirms the control
answer, never that the queue was answered. A lost answer is re-sent with the same
body, never one rebuilt from a newer record.

### Leaving the chat: the graph and the conversation

[Turn reads return the conversation][kb-graph]. The adapters own the SQL predicate
(`inConversationSql`, which also applies the forgetting stamp; `notHandedBackSql`
stays for identity reads), and it also guards transcript page keys, counts and
ordinals, `listMessageDeliveries`, `listLatestLocalRequesterText` and the
chat-activity projection.

Biome's `noRestrictedImports` limits who imports `threads/ports/turn-graph.ts`. Add
a module to that list only when it walks `prevTurnId` or positions and filters its
output. The compaction projection drops a pin to a handed-back turn and resolves a
cut at one by position.

### Forgetting a failed attempt

The rule is [a failed attempt is forgotten][kb-forget]. Run start decides first
and hands the result to the append primitive as `expectedForgetting`, which throws
`ForgettingMismatchError` if the transaction decides differently, because the
request would then have been built on the wrong history.

## Selection and admission

`wakeIfRunnable` rereads after release and setup cancellation; the periodic sweep
is the durable backstop, and an empty reread has to stop rather than spin.

An open ask blocks ordinary selection and prefix materialization. A writer send
still commits whole through the mid-run admission path, while run state keeps the
bubble queued and no request adopts it. Resolution replaces that barrier with one
internal `ask_resolved` inbox row, which reserves the next run start and adopts
eligible queued messages only up to the first write-mode switch. The row is only
the wake hint: what the continuation owes is `asks.continuation`, which admission
claims in the reservation commit (`continuationOwedSql` is the rule), acknowledging
the row there. A hint whose ask owes nothing any more is retired without a run.
Delivery rechecks this under the thread lock; SQL wake discovery only avoids wasted
starts.

`UserTurnAdmission` is the writer fence under the thread lock, in the order
validate, record, enqueue: replay identity settles first, then the writer turn,
inbox message, activated-skill metadata, provenance, admission ledger, upload
consumption and document attachments commit together. Archiving the bound Work does
not freeze its chats: sends, retries and ask answers remain admissible.

A writer turn that joins a live assistant binding with no queued write-mode switch
is stamped `metadata.delivery: "steer"`; otherwise (idle, or behind a queued switch)
`send`. The producer decides under the thread lock on every turn-start attempt, so
a switch another tab commits first is always seen. Writer enqueue materializes older
directed messages and pending notices under the same lock, so turns follow inbox
order.

A thread blocked on credits resumes through the ordinary wake sweep; clients don't
poll for restored balance.

## Prepare and commit

One `prepareAndCommit` serves drain start and mid-run adoption
([protocol][kb-run-prep]). Inbox receipt membership lives in
`thread_run_leases.adopted_message_ids`, not turn metadata. Binding, response
persistence, acknowledgement, receipt clearing and terminal lease release are
transactionally paired. Orphan recovery never retires a receipt whose selector names
a terminal turn. Setup errors before adoption skip the immediate reread as the
hot-loop guard.

## Materialized context

Existing writer turns are adopted without a second append. Activated skill bodies
become hidden sibling system turns, never blocks on the writer turn.

Which mutations enqueue a Work refresh: every change to a chat's Work facts (model
and Work-screen edits, receipt reversal, thread restore, the explicit rebind)
enqueues one marker per affected thread, hidden and unfrozen threads included. The
model's own `work` update, archive or unarchive skips the calling thread, whose tool
result already carries the new value (a notice there split the reply into two
assistant turns); `switch` still notifies its own thread. Creating or deleting a
Work targets nothing. Only a real deleted-to-visible restore enqueues, and an
inherited fork or handoff enqueues one so its first request carries current Work. A
writer Work switch also records a one-shot switched notice. An idle thread
materializes the update without a model call, and the recovery lane materializes the
rest.

## References and images

Admission resolves document and folder identities at their submitted canonical URI;
a mismatch becomes plain text. Folder references persist on the message but cause no
attachment, upload, image or read effect. Current-turn document references load
outside admission transactions and persist server-side evidence before gateway
submission; duplicates read once per turn and replay reuses frozen results.

Image inclusion decisions are append-only by deciding turn. An upsert would lose the
decision as of an earlier turn and drop an image from a later fork with no notice.
The removal notice turn owns the decisions it reports, so a decision and its
explanation fall on the same side of any fork cutoff. Blocks retain identity, never
bytes or inclusion state.

[kb-delivery]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/server-runtime.md#one-delivery-boundary-and-one-run-claim
[kb-run-prep]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/server-runtime.md#preparing-a-run-select-prepare-validate-commit
[kb-run-identity]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/server-runtime.md#run-identity-is-written-once-by-the-server
[kb-run-state]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/chat-sync.md#one-run-state-record-per-chat
[kb-stop]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/chat/composer-and-queue.md
[kb-graph]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/chat/turns.md
[kb-forget]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/chat/turns.md
