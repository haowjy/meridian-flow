# Handoff brief

A handoff creates a destination thread and pending system seed S. The independent
brief service owns generation, Stop, Retry, accounting, and release wake; a
brief is not a run or inbox item. Creation and HTTP contracts live in the
[threads domain](../../threads/.context/CONTEXT.md) and [handoff API](../../../../../../docs/api/thread-handoff.md).

## Claim and seed lifecycle

Handoff first performs an idempotent destination lookup. If absent, it holds
the destination `RunClaim` before creating the thread, S, and source event in
one transaction. The held claim has no lease. A competing holder creates
neither seed nor thread and returns `handoff_in_progress`; Retry uses the same
sequence and returns `handoff_retry_unavailable` when unavailable.

After commit the brief service registers cancellation and remote Stop polling
before notes copying. Creation awaits that bounded preparation, not generation.
A copy deadline settles S as interrupted (retaining the original-notes pointer)
and releases the claim; ordinary copy errors still allow generation. Stop
cancels preparation and releases only after rollback. The brief keeps the claim
through its ending transaction; a destination wake cannot start while S is
pending. Release calls the shared `wakeIfRunnable`, which rereads the queue so
messages, controls, and Work notices run after S without a seed-specific gate.
A rollback or untransferred path releases the claim.

`brief-request.ts` prepares the source-shaped request through the selected turn
and invokes the shared [summarizer](summarizer.md) once. The path is known-too-
large → rolling, warm → source-model branch, cold → rolling; preparation or
summary failure is final and needs a new S to retry. S freezes source identity,
cutoff, typed summary telemetry, and the `handoff-brief` block. A writer
message at the cutoff is reported as open, not answered by the brief.

Returned provider rows and debits settle in S's ending transaction. Stop settles
S as cancelled under the destination lock and aborts the local worker; it sends
no separate wake. Claim loss or shutdown leaves S pending so recovery can mark
it interrupted; only Stop settles cancelled. A launched brief after shutdown
also leaves S pending. The bounded tracker drains detached work before process
exit.

## Projection and lineage

The status reader projects pending S as `awake/generating` without a running
turn id; this is an indicator, not a lease. Orphan repair writes an unavailable
card, interrupted recovery metadata, and the history read line. A settled seed
appends `threadReferenceText` only when its bake advertises `thread_history`;
source history is never copied.

A handoff starts a new `rootThreadId` while retaining `originTurnId`. Its No Work
Scratch belongs to its new lineage; its associated thread folder receives a
best-effort independent copy of the acted-on chat’s notes. The seed names the
original canonical notes address even on copy failure. Source lineage remains
reachable through its first-chat handle. Forks do not re-root, and credits/results use the new root.
