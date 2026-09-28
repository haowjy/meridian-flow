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

C7a injects `handoffSummarizer` using the existing summary outcome, with scripts
in protocol tests. The composition root deliberately supplies an unavailable
adapter, not a fabricated brief. C7b replaces this seam with the shared
owner/source-aware summarizer and owns source projection/cache preparation,
response settlement, costs and typed failure metadata. No paid response rows
are produced by the C7a adapter.
