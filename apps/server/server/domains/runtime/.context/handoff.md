# Handoff seeds

The first seed is already in the destination chain before a run exists. Its
pending control owns it through `body.seedTurnId`. Shared `finalizeOrphanedTurns`
re-reads pending ownership under the thread lock at run start, idle materialization,
and orphan scanning; a crashed
brief redelivers into the same seed, not an interrupted replacement.

The barrier gives a row-owned seed an empty adoption batch. Messages already
chained after it are late arrivals. Run start binds S; the slow brief call runs
without a transaction. The ending delivery commit settles S, acknowledges K,
adopts arrivals and binds the next control or reply (or releases a quiet lease).
A missing or settled row-owned seed is not a barrier: delivery retires its
control in the replacement reservation transaction, or alone when no messages
remain. Stop and withdrawal acknowledge such controls without re-finalizing
the seed. If a live brief discovers a settled seed, it retires its control and
lets the normal wake answer queued messages from durable context.

Retry enqueue is server-gated: the latest handoff seed must be `error` or
`cancelled`, with no pending brief control. Replaying an existing matching
control id remains idempotent even after success; a fresh id must pass the gate.
Retry has no seed pointer: its new seed is reserved at the execution leaf.
The current-turn kind is `handoff_brief`; the live phase is `briefing`. Only
run-owned system turns dispatch here; completed undo markers take the terminal
route first (see [placeholder ownership](compaction.md)). A handoff anywhere
in the expanded controls list suppresses successor compaction.

The source ref is frozen in seed metadata; Stop/failure needs no source lookup.
An expired lease receipt does not block row-owned Stop. The brief ending commit
re-reads S under the thread lock. If Stop already settled it, the stale run exits
with that durable turn; it cannot overwrite the fallback or prepare a successor
from its discarded brief.

Success stores a `handoff-brief` custom block with frozen `modelText`. Failure
and Stop store the source-naming unavailable block. Model rendering replays
that text verbatim. Neither first-send nor Retry reads source history into the
destination request. Stop releases unanswered messages. Before binding, Stop
and withdrawal settle S themselves, under the same thread/receipt locks as
reservation; after binding they cancel its owning run.

## Source preparation and metering

The shared summarizer separates `owner` (destination and S, for gateway
correlation and response rows) from `source` (cutoff owner and cutoff, for the
binding, model, cache and transcript). The fork loader also loads arbitrary
through-cutoff effective transcripts; handoffs never inherit those turns.

`handoff-brief.ts` previews the source request through the cutoff without
persisting a bake, reference reads, image decisions or pre-generation turns.
New image/pre-generation events make the preview ineligible for warmth.
Preview-only failures also go cold; a missing transcript still fails the brief.
With the cheap model available, cold needs neither a source bake nor a resolved
source binding. Without that provider, it falls back to the retained source model.
An older cutoff is `cold/fork_cutoff`; a current warm prefix uses the source
model, unchanged tools, and one appended instruction naming the incoming
Agent. Cold rolls the active source projection through the cheap summarizer.
The instruction does not advertise `thread_history`.

Destination binding/bake/fit preparation belongs to the successor after S's
outcome is known. A destination preparation failure lands on the reply, not S.
Skill bodies on chained messages adopted ahead of Retry are staged after the
brief, before the reply. Due undo controls and following batches use ordinary delivery selection and
ending-control acknowledgement, including when no reply remains.

Both successful and failed summaries return every attempted paid row.
`settleSummaryResponses` only meters and journals rows; each owner writes its
own telemetry. `recordHandoffSeedOutcome` owns brief telemetry and failure
metadata through `HandoffSeedMetadataCodec`, never the compaction codec. Summary rejection reasons are shared contracts; each
owner composes its own failure phases. Failed S records reason and phase in
metadata and `handoff_brief_failed` details, with writer copy in `turn.error`.
Rows attach to S, debit the destination run's shared tree budget and source
root, and retain source-evaluated predictions. Only assistant responses supply
future prefix warmth or token baselines.

A process kill during the provider call leaves the row-owned S and K pending.
Recovery preserves S and retries the brief. Paid calls still held only in
memory are lost and cannot be debited, as for compaction. A live stale brief
that returns after row-owned Stop preserves the cancelled fallback and settles
its returned rows without reviving S or replacing the winning telemetry.
Telemetry is written only by the pending owner’s ending transaction.

Warm preparation intentionally does not compact the source or enforce the
destination’s fit limits. If the source-shaped request exceeds the provider
window, the shared summarizer retains that attempt and falls back cold.
