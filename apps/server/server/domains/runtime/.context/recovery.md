# Recovery: orphan repair and process lanes

Recovery repairs pending runs, placeholders, and child reports after ownership
is proven dead. A handoff brief uses the destination's ordinary run claim, not a
separate recovery owner. See the [process-death decision][kb-process-death].

## Placeholder and run repair

`PENDING_PLACEHOLDER_ROLES` discovers compaction and handoff system placeholders.
The repair lane first acquires the destination session claim and thread lock;
expired lease time alone never proves death. It then finalizes the dead reply,
retains its adopted-message receipt long enough to retire and acknowledge the
exact batch, and clears the turn selector/bound-turn set. Messages not adopted
by the dead run remain queued. A crashed child publishes one failure report and
is not restarted for its retired parent message.

Once the session claim proves the prior owner is gone, `settleStaleExecution`
repairs while the stale row still holds the dead reply's turn and
adopted-message IDs, then ends that execution and deletes the row before any
new lease is inserted ([run identity](delivery.md#run-identity)). Compaction
uses `finalizeExecution`; handoff uses `completeHandoffSeed` to write an
unavailable card, interrupted metadata, and history read line. A durable failed
reply acknowledges its adopted messages and is not restarted by the periodic
wake sweep. Explicit Retry of the latest failed assistant starts an ordinary
no-input run with the failed turn in history.

## Lease settlement

Sweep lanes (unsettled-turn, placeholder, report, and expired-lease) delegate to
delivery's `settleStaleExecution` inside one thread-lock transaction. The
callback decides whether to delete the stale lease and publishes the resulting
run-state record in that transaction; status publishes only after commit. A rollback keeps both
unfinished work and lease. Every path that finalizes orphans under the claim
(run start and idle materialization) goes through
the delivery adapter's one `repairOrphans` helper.

Release is guarded: delivery re-reads the receipt and ends the execution
(lease deletion and the closed run-state record in one transaction) only if the same execution
and holder still own the row and both selector and adopted IDs are empty. A
sweep candidate may have become a newer orphan; unconditional deletion would
lose that receipt and replay its adopted message. Terminal paths release their
lease in their own terminal transaction, including terminal placeholders,
normal close, and failed compaction successors.

Recovery decisions must be proven against the production database adapter; an
in-memory claim is not parity authority. Paid response rows held only in memory
at process death are lost and cannot be debited.

## Handoff and process lanes

A pending handoff seed is repaired by the ordinary placeholder sweep after a
shutdown, claim loss, or ending-transaction failure. There is no handoff
relaunch counter or separate handoff sweep. While a brief is in a provider call,
its bounded status poll notices that repair settled S and aborts without
relaunching. The ordinary wake sweep remains the backstop for durable inbox
messages.

Production SIGTERM/SIGINT runs the bounded shutdown drain. Nitro dev may exit
through its worker runner, leaving repair to restart. Shutdown aborts live work
with reason `shutdown` after paid rows settle, acknowledges receipts, and
suppresses new starts and wakes.

[kb-process-death]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/process-death-turn-recovery.md
