# Runtime compaction

Compaction reserves a placeholder C at a run boundary, makes one unlocked call to
the shared [summarizer](summarizer.md), then commits a successor reply B that
opens a prompt epoch. Policy is in the KB: [run preparation][kb-run-prep],
[summary and overflow][kb-summarizer], the [notes step][kb-notes],
[ranked re-show][kb-reshow] and [`/compact`][kb-commands].

## Protocol

Reservation, summary preparation, and successor completion are separate
transitions around the unlocked provider call:

1. The boundary's preparation commit reserves C with its trigger and consumes
   the selected compact command. If the pinned requests plus minimal suffix
   cannot fit, no C is persistable and preparation fails.
2. The summary phase prepares a provisional completed C, then prepares late
   arrivals. Reference reads belong to C; B does not exist until successor
   commit.
3. Successor commit joins paid-summary settlement, `beginPromptEpoch`, adoption,
   notice consumption, and B's reservation. A moved leaf repeats successor
   preparation only, never the summary call.

A message waiting behind a queued write-mode switch makes the successor commit
[yield](controls.md#the-yield) instead: C completes with its own outcome and no B
is reserved.

The summary block's token count describes the compacted base before late
arrivals. Prepared `elisions` and settled summarizer telemetry both reach
`beginPromptEpoch`; telemetry never enters model text.

## Important files

Selection, budget and evidence rules are in [ranked re-show][kb-reshow]. Each
admitted read persists on C as a reference snapshot, and the projector keeps those
block ids, so completion records shown links and observation frontiers against the
exact blocks the model receives. Only the winning completion transaction records
them; a retried successor preparation reads again.

## Projection

`projectActiveHistoryWithBakes` is the only public active-history projector, used
by request assembly, summary preparation and handoff. The synchronous one stays
private because it can drop the sentence that depends on C's own bake.

A compaction led by a Retry pins the messages the retry keeps
(`pinnedRequestTurnIds` is the outstanding messages plus `retryReservedFor`), and
the blocks it summarizes are intersected with the kept turns.

## Failure, cancellation, and images

Late arrivals get their own preflight: they may trigger another compaction,
proceed when over the trigger but within the usable window, or fail B with
`context_too_large`. C still commits.

A live unexpected error closes C, settles its rows, fails B below late arrivals,
acknowledges the receipt and releases the lease in one transaction. If that
transaction fails, orphan recovery owns C and nothing further settles. Stop aborts
the summary and settles its rows on cancelled C; late arrivals stay queued.

Complete compaction is the only image-budget rebalance seam. It projects late
arrivals first, then admits retained excluded candidates newest-first without
evicting existing inclusions. Missing or transiently unresolved assets keep prior
decisions; unexpected resolution errors fail preparation. C owns these decisions,
so a fork inherits them only when its cutoff includes C.

[kb-run-prep]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/run-preparation-protocol.md
[kb-summarizer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/compaction-summarizer-and-overflow.md
[kb-notes]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/compaction/notes-step-before-compaction.md
[kb-reshow]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/compaction/compaction-document-reshow.md
[kb-commands]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/transcript-commands.md
