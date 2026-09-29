# Handoff brief

A handoff creates a destination and a pending system seed S. The
`runtime/handoff/brief-service.ts` owns brief generation, Stop, Retry,
accounting, and release wake-up; the brief is not a run or inbox item. Creation
and HTTP contracts are in the [threads domain](../../threads/.context/CONTEXT.md)
and [handoff API](../../../../../../docs/api/thread-handoff.md).

## Claim lifecycle

Hand off first does an idempotent lookup. If no destination exists yet, it
acquires that destination's `RunClaim.hold` before creating it. A held claim has
no lease or running-turn id. If another operation owns the claim, no seed or
thread is created and the request returns 409 `handoff_in_progress`; retrying
the request after the first transaction commits replays the existing thread.
The creating transaction writes the destination, pending S and source event.
After commit, the request transfers the claim to a detached brief. A rollback
or any path that does not transfer the claim releases it.

The brief keeps the destination claim through its one ending transaction. A
destination wake while S is pending cannot start a run; the claim owner's
release calls the shared `wakeIfRunnable`, which rereads the queue. Messages,
controls and Work notices therefore remain durable and run after S, without a
pending-seed gate or a separate brief claim. Retry applies the same rule: an
idempotent seed lookup first, then `RunClaim.hold`, then create and detached
launch. The launch registers with the runtime composition's shared detached
work tracker. A held claim returns 409 `handoff_retry_unavailable`.

## Seed lifecycle

`handoff/seed.ts` owns the frozen card block and terminal projection.
`handoff/brief-request.ts` prepares the source-shaped request through the
selected turn and invokes the shared [summarizer](summarizer.md) once. The
shared rule is known-too-large → rolling, warm → source-model branch, cold →
rolling. Source preparation or summary failure is final; there is no fallback.
A writer message at the cutoff is reported as an open request, not answered by
the brief.

S stores source id/ref/title and cutoff. A terminal S stores typed summary
telemetry and a frozen `handoff-brief` block. Writer-facing failure copy never
includes the internal cause. Returned provider response rows and debits settle
in the same ending transaction as S. If that transaction throws, the claim is
released and S remains pending for ordinary orphan repair.

Stop settles S as cancelled under the destination lock, stamps the destination's
pending commands to run first in that transaction, and aborts a local worker. A
remote worker notices within the five-second status poll. A dead
database session is detected by the session lock only on its next query; while
the brief is in a provider call, its five-second S status poll is the mechanism
that notices claim loss after repair settles S. Claim loss and shutdown are
distinct aborts: only Stop settles cancelled; the others settle available paid
rows while leaving S pending so repair can record it as interrupted. A failed
source preparation or summary attempt is final and can be retried by the writer
with a new S. Shutdown sets the shared flag before aborting live runs and briefs
with reason `shutdown`, suppressing new run starts and wakes. Live work is
aborted so paid response rows settle before claim release. The app's shared
runtime tracker drains for at most 10 seconds and reports a timeout. A brief
launch that begins after shutdown has started leaves S pending for ordinary
orphan repair. A released claim does not wake the destination after shutdown.

## Read models and recovery

The thread status reader projects a pending S as `awake/generating` with no
`runningTurnId`; this is a working indicator, not a lease. Brief start and
terminal settlement publish `thread.status`. A brief claim is the destination
run claim, backed by the same process-shared PostgreSQL session advisory lock
and dead-session cleanup used by runs.

A pending S is a normal pending `system` placeholder. Orphan repair settles it
as interrupted (`phase: recovery`), writes its unavailable card and history
read line, then publishes status. No brief recovery lane, relaunch counter, or
special pending-seed query remains. Seed `modelText` appends
`threadReferenceText` only when its bake advertises `thread_history`; source
history is never copied into the destination. `HandoffSeedMetadataCodec` owns
the summary telemetry and failure reason/phase.
