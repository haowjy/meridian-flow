# Recovery: orphan repair and process lanes

Recovery repairs pending runs, placeholders and child reports. A handoff brief
is protected by the destination's ordinary run claim, not a separate recovery
owner. See the [process-death decision][kb-process-death].

## Placeholder repair

`PENDING_PLACEHOLDER_ROLES` defines both transcript placeholders and discovery
for repair (`compaction` and handoff seed `system`). A run or brief owns the
same destination claim while active, so a pending placeholder discovered after
acquiring that claim is orphaned. `finalizeOrphanedTurns` and the placeholder
lane in `spawn/orphan-report-repair.ts` repair it; they also repair dead
primary assistant turns. Compactions use `finalizeExecution`. Handoff seeds
use `completeHandoffSeed` to write an unavailable card, interrupted recovery
metadata and history read line.

Run repair holds the destination thread lock and run claim. Expired lease rows
alone do not prove death. Once the session claim proves the prior owner is gone,
the replacement lease retains the dead reply's turn and adopted-message IDs.
Repair finalizes that reply and atomically retires and acknowledges its exact
receipt, whether the reply belongs to a primary or child thread. Late messages
that the dead run never adopted stay queued, and a crashed child publishes one
failure report without starting again for the retired parent message.
Run-start repair (`repairOrphanedTurns`) keeps the replacement run's
already-acquired lease; it only retires the inherited dead receipt before
selecting new work.

## Settling a stale lease

The bounded sweep lanes in `spawn/orphan-report-repair.ts` hold the exclusive
session claim and pass their repair to delivery's `settleStaleExecution`. One
thread-lock transaction runs the repair, decides whether to delete the stale
lease row, and journals the resulting inbox projection. After commit it
publishes `thread.status`, so subscribers read asleep at once and a new message
starts without waiting for the dead lease to expire. A rollback keeps both the
unfinished turn and its lease and publishes nothing.

- **Release only an empty receipt, never unconditionally.** Delivery captures
  the receipt's run and holder before the repair and re-reads it afterward. It
  calls `RunClaim.release` only when the same run and holder still own the row
  and both the turn selector and adopted-message IDs are empty. A sweep
  candidate can be stale: between selection and claim, its execution may have
  completed and a newer run may have adopted a message and died. A successful
  repair callback proves nothing about that newer receipt, and deleting it
  would leave the adopted message queued to be answered again. The newer
  orphan keeps its receipt for its own repair.
- **Terminal paths release in their terminal transaction.** Because the sweep
  keeps any non-empty receipt, and discovery finds only unsettled turns, a
  lease whose selector points at an already-terminal turn is never retired: the
  chat stays awake with an empty inbox. Every path that writes a run's last
  terminal turn therefore releases its lease in the same transaction: a
  terminal placeholder, both `close` branches, and a failed compaction
  successor (`failCompactionSuccessor`). A new terminal path must do the same
  instead of leaving release to session cleanup.
- **Prove it against the DB.** The in-memory run claim is not a recovery
  parity authority (see `TODO`); recovery regressions belong in the
  production-adapter DB suites.

Every finalized orphan clears the dead turn selector and bound-turn set before
later work can start. Non-reply repair, including a crashed compaction, clears
the receipt without acknowledging its adopted messages so the next run can
deliver them.

A reply that reaches a durable failed terminal state, including through orphan
repair, acknowledges every message it adopted and is never restarted by the
30-second inbox wake sweep. Crash repair keeps the internal `orphaned` reason
because no shutdown signal reached the runtime, but uses the same writer copy,
“This response failed.” An explicit Retry of the latest
failed assistant on an idle primary or subagent thread starts an ordinary
no-input run; prior user turns already carry its request history. Shutdown
abort is finalized the same way as a failed reply, with `reason: shutdown` and
“This response failed.”, after paid rows settle and adopted messages are
acknowledged, so the writer can Retry after restart.

Production SIGTERM and SIGINT run the bounded shutdown drain before exit. Nitro
dev intentionally keeps the upstream crash-style worker termination and relies
on this repair path after Ctrl+C or SIGTERM.

## Handoff claim and release

Hand off and Retry take `RunClaim.hold` before creating S. The claim has no
lease, so pending S reports `awake/generating` with no running turn id. Once
the ending transaction finishes, the brief releases the claim and calls
`wakeIfRunnable`; a lost wake during brief generation is picked up by this
queue reread. A shutdown or lost claim abort leaves S pending; the next run
start or bounded placeholder sweep repairs it as interrupted. An ending
transaction failure follows the same path. There is no handoff sweep, relaunch,
counter or brief-specific claim.

The ordinary wake sweep remains the backstop for durable inbox messages whose
wake could not start a run. `drizzle-session-lock.ts` invalidates claims when a
database session dies, but it detects that only on the session lock's next
query. While a brief is inside a provider call, its five-second S status poll
is how it notices that repair has settled S after the claim was lost; the brief
then aborts without relaunching. This allows stale ownership to clear without
wedging later claim attempts.

Paid response rows held only in memory at process death are lost and cannot be
debited; the next repaired or retried attempt may make a duplicate provider
call.

[kb-process-death]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/process-death-turn-recovery.md
