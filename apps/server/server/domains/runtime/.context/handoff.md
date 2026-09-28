# Handoff brief

A handoff creates a destination and a durable pending system seed S. The
independent `runtime/handoff/brief-service.ts` owns launch, Stop, Retry,
settlement, wake and crash recovery; it does not enter the destination inbox
or run loop. Creation and HTTP contracts are in the
[threads domain](../../threads/.context/CONTEXT.md) and
[handoff API](../../../../../../docs/api/thread-handoff.md).

## Seed lifecycle

`handoff/seed.ts` owns the frozen card block and terminal projection.
`handoff/brief-request.ts` prepares the source-shaped request through the
selected turn and invokes the shared [summarizer](summarizer.md). The request
branches at every cutoff (`path: "branch"`) with the source bake and tools in
effect at the cutoff; model and thinking settings come from the source's
current binding. A failed source preparation or branch attempt uses the rolling
summarizer fallback. A writer message at the cutoff is reported as an open
request and is not answered by the brief.

S stores source id/ref/title, cutoff, and a `launches` recovery counter. It is
the durable pending signal. A terminal S stores the typed summary result and a
frozen `handoff-brief` block; writer-facing failure copy never includes the
internal cause. Every provider response row settles on S and debits the shared
lineage tree budget.

The destination cannot start a run while any handoff seed is pending. The
pending check occurs before lease acquisition, in the locked commit, and in the
pending-message sweep. A gated start releases its lease and rechecks for the
lost-wake window. Once S settles, Stop or failure, the service wakes the
destination; queued messages remain chained after S. No placeholder repair
path owns S: the independent claimed sweep relaunches pending seeds, up to
three launches, then settles a poison seed as interrupted.

Stop (`HandoffBriefs.stop`) settles S directly under the destination lock and
aborts a local worker. A remote worker polls S every five seconds. Retry
appends a new seed at the destination leaf only when the latest seed failed or
was stopped and no destination run lease is live. Replays of the same new id
are idempotent. See the [API contract](../../../../../../docs/api/thread-handoff.md).

## Read models and claims

The thread status reader projects a pending S as `awake/generating` with no
`runningTurnId`; this is a working indicator, not a lease. Launch and terminal
settlement publish a `thread.status` refresh. A process-shared PostgreSQL
session advisory claim serializes attempts for one seed and notifies a local
worker if its reserved session is lost. The destination's normal run claim is
never acquired for the brief.

Seed `modelText` appends `threadReferenceText` only when S's bake advertises
`thread_history`; source history is never copied into the destination.
`HandoffSeedMetadataCodec` owns `summarizer` telemetry and failure reason/phase,
separately from compaction metadata.
