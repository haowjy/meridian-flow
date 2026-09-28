# Handoff seed and brief

A handoff creates a destination chat whose first turn is a seed S: a pending
`system` placeholder that a model-written brief of the source fills. The brief
is a queued `handoff_brief` control ([controls](controls.md)) and one call of
the shared [summarizer](summarizer.md). Creation and its HTTP contract are the
threads domain's
([handoff API](../../../../../../docs/api/thread-handoff.md)). Rationale:
[A Handoff Starts With a Row-Owned Seed][kb-seed].

| File (under `loop/`) | Role |
|---|---|
| `handoff-brief.ts` | Prepares the source read-only and summarizes it for the destination-owned seed. |
| `handoff-seed.ts` | S's frozen model context, including the no-brief terminal states. |
| `execution-finalizer.ts` | `recordHandoffSeedOutcome`, the one writer of S's telemetry and failure metadata. |

## The row-owned seed

The first seed is already in the destination chain before a run exists. Its
pending control owns it through `body.seedTurnId`, so orphan repair leaves it
pending and a crashed brief redelivers into the same seed, not an interrupted
replacement. The ownership check lives in the one orphan finalizer
([recovery](recovery.md)).

The barrier gives a row-owned seed an empty adoption batch. Messages already
chained after it are late arrivals. Run start binds S; the slow brief call runs
without a transaction. The ending delivery commit settles S, acknowledges K,
adopts arrivals and binds the next control or reply (or releases a quiet
lease). A missing or settled row-owned seed is not a barrier: delivery retires
its control in the replacement reservation transaction, or alone when no
messages remain. Stop and withdrawal acknowledge such controls without
re-finalizing the seed. If a live brief discovers a settled seed, it retires
its control and lets the normal wake answer queued messages from durable
context.

Retry enqueue is server-gated: the latest handoff seed must be `error` or
`cancelled`, with no pending brief control. Replaying an existing matching
control id remains idempotent even after success; a fresh id must pass the
gate. Retry has no seed pointer: its new seed is reserved at the execution
leaf. The current-turn kind is `handoff_brief`; the live phase is `briefing`.
Only run-owned system turns dispatch here; completed undo markers take the
terminal route first. A handoff anywhere in the expanded controls list
suppresses successor compaction.

## Stop and the ending commit

The source ref and display title are frozen in seed metadata; the title is
projected to terminal `handoff-brief` props, never into `modelText`, so
Stop and failure need no source lookup. An expired lease receipt does not
block row-owned Stop. Before binding, Stop and withdrawal settle S themselves,
under the same thread and receipt locks as reservation; after binding they
cancel its owning run. Stop releases unanswered messages.

The brief ending commit re-reads S under the thread lock. If Stop already
settled it, the stale run exits with that durable turn; it cannot overwrite the
fallback or prepare a successor from its discarded brief. A live stale brief
that returns after row-owned Stop preserves the cancelled fallback and settles
its returned rows without reviving S or replacing the winning telemetry.
Telemetry is written only by the pending owner's ending transaction.

## What S renders

Success stores a `handoff-brief` custom block with frozen `modelText` and the
seed's frozen source title for display. Failure and Stop store the
source-naming unavailable block. Model rendering replays that text verbatim.
When a seed finishes, the brief and the finalizer append the
`threadReferenceText` read line inside `<system_update>` only if the bake at S
advertises `thread_history`; the rule is in
[history tools](history-tools.md#history-guidance-follows-the-bake). It never
resolves the destination binding for this decision. Successful and failed
summaries, Stop, and recovery all get the line, and existing S blocks keep
their bytes. Neither first send nor Retry reads source history into the
destination request.

## Source preparation

The summarizer's `owner` is the destination and S; its `source` is the cutoff
owner and the cutoff. The fork loader also loads arbitrary through-cutoff
effective transcripts; handoffs never inherit those turns.

`handoff-brief.ts` previews the source request through the cutoff without
persisting a bake, reference reads, image decisions, or pre-generation turns.
New image or pre-generation events make the preview ineligible for warmth.
Preview-only failures also go cold; a missing transcript still fails the
brief. With the cheap model available, cold needs neither a source bake nor a
resolved source binding; without that provider, it falls back to the retained
source model. An older cutoff predicts `cold/fork_cutoff`. A current warm
prefix uses the source model, unchanged tools, and one appended instruction
naming the incoming Agent; that instruction does not advertise
`thread_history`. Cold rolls the source's active projection
(`projectActiveHistoryWithBakes` with the source ref and the source C's bake)
through the cheap summarizer, so a compacted source keeps its summary bytes.

Warm preparation intentionally does not compact the source or enforce the
destination's fit limits. If the source-shaped request exceeds the provider
window, the summarizer retains that attempt and falls back cold.

Destination binding, bake, and fit preparation belong to the successor after
S's outcome is known; a destination preparation failure lands on the reply,
not S. One skill-body staging owner serves run start and successor
preparation. Normal runs stage bodies before fresh messages; a pending brief
defers them until after S and before the reply. Only a committed body
consumes its activations, so optimistic preparation can repeat. Brief-only
batches need no control-history preparation; an expanded undo prefix before
Retry still does. Due undo controls and following batches keep ordinary
delivery selection and acknowledgement, including when no reply remains.

## Outcome and metering

`recordHandoffSeedOutcome` writes brief telemetry and failure metadata through
`HandoffSeedMetadataCodec`, never the compaction codec. Failed S records a
`reason` (the shared summary rejections plus `handoff_brief_failed`, and
`interrupted` from recovery) and a `phase` (`source_prepare`, `summary`,
`delivery`, `recovery`) in metadata and in the `handoff_brief_failed` event
details, with writer copy in `turn.error` on every path. Ending-commit
exceptions keep their internal cause in the event's `details.cause`;
operational logs use the sanitized error payload.

Rows attach to S, debit the destination run's shared tree budget and source
root, and keep source-evaluated predictions. Settlement is the summarizer's
([paid rows](summarizer.md#paid-rows-and-settlement)).

A process kill during the provider call leaves the row-owned S and K pending.
Recovery preserves S and retries the brief; paid calls held only in memory are
lost.

The delivery and orphan-repair compositions must pass the same registered-tool
reader as the loop. Omitting it means a tool-less runtime, not automatic
production defaults; a missing reader on a fresh seed freezes no read line.

[kb-seed]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/handoff-seed.md
