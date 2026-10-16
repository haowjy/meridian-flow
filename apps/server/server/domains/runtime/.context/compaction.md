# Runtime compaction

Compaction reserves a placeholder C at a run boundary, performs one unlocked
summary call, then commits a successor that opens a prompt epoch. The summary
call is the shared [summarizer](summarizer.md); orphan C is repaired by
[recovery](recovery.md). Manual `/compact` is selected at run start under the
[control queue](controls.md), and stale document text is [elided](document-text.md).
Rationale: the [run preparation protocol][kb-run-prep] and
[summarizer/overflow][kb-summarizer] decisions.

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

**The yield exception.** If the boundary after the summary finds a message
waiting behind a queued write-mode switch (`S, M2`), the successor commit
yields instead: C completes with its own outcome through its placeholder
callbacks, nothing is adopted, no notice is consumed, no B is reserved, and
the claim is released. C's receipt stays unacknowledged, so its messages and
M2 wait for the next run, which starts after the release wake; that run applies S at its start. See
[controls](controls.md#the-yield) for the ordering and receipt rules.

The summary block is immutable. Its fit limit comes from the decision; its token
count describes the compacted base before late arrivals. Only assistant response
rows supply a reusable token baseline. Prepared `elisions` and settled
summarizer telemetry must both reach `beginPromptEpoch`; telemetry never enters
model text.

## Decisions and projection

A decision is automatic, manual, or overflow. Pins preserve unanswered
requests and the newest writer request; adopted-but-unanswered requests remain
pinned. Manual compaction requires a completed reply and may use the minimal
tail when the normal tail leaves nothing to summarize. A minimal tail that does
not fit fails `context_too_large`. Instructions are stored on C and apply to
both warm-branch and rolling prompts.

`projectActiveHistoryWithBakes` is the only public active-history projector. It
resolves C's own prompt bake before adding the history-read sentence, retains
C's frozen elisions, and is used by request assembly, summary preparation, and
handoff. `projectCompactedHistory` narrows it to the cut for rolling summaries.
The synchronous projector is private because it can drop the bake-specific
sentence.

A compaction is a closing row for forgetting ([delivery](delivery.md#forgetting-a-failed-attempt)):
one that follows an empty failed reply forgets that attempt and its messages.
A cut may be empty (`EMPTY_CUT`, `turnId: null`), which `plan.ts` treats as no
cut. A compaction led by a Retry pins the messages the retry keeps
(`pinnedRequestTurnIds` is the outstanding messages plus `retryReservedFor`), and
the blocks it summarizes are intersected with the kept turns.

## Trigger and estimator

`request-preparation.ts` measures the assembled request against raw history.
Without an explicit Agent limit, the default trigger is 90% of the lesser of
the model's input pricing tier and usable window, capped at 400,000 tokens.
Explicit token/percentage limits are not scaled. The estimator excludes
elision payloads from C's header.

Every registry model declares a required tokenizer family (`anthropic`,
`o200k`, `gemini`, or `deepseek`); there is no fallback family. CJK rates are
family-specific and must be refreshed through the compaction-estimate probe,
not replaced with one global constant. The registry model's usable window and
output reserve supply the fit limit.

## Failure, cancellation, and overflow

A failed automatic summary fails the reply; a manual command failure errors C
only. C records typed reason/phase and fit measurements where applicable, while
`turn.error` carries the outcome. Late arrivals get their own preflight: they
may trigger another compaction, proceed when merely over the trigger but within
the usable window, or fail B with `context_too_large`. C can still commit.

A live unexpected error closes C, settles its rows, fails B below late arrivals,
acknowledges the receipt, and releases the run lease in one transaction. If
that transaction fails, orphan recovery owns C and no further settlement is
attempted. Stop aborts the summary and settles its response rows on cancelled
C; late arrivals remain queued.

The gateway maps provider context-window failures to `context_overflow`. The
loop completes A at its last persisted tool group, prepares forced rolling
compaction, and retries once per reply. A second overflow fails
`context_window_exceeded` and acknowledges the receipt; metered overflow output
is billed without retaining incomplete blocks.

Complete compaction is the only image-budget rebalance seam. It projects late
arrivals first, then admits retained excluded candidates newest-first without
evicting existing inclusions. Missing or transiently unresolved assets keep
prior decisions; unexpected resolution errors fail preparation. C owns these
decisions, and forks inherit them only when their cutoff includes C.

Summary rows settle through [summarizer settlement](summarizer.md#paid-rows-and-settlement)
in the transaction that ends C. A child report's cost covers each assistant
and compaction response from its selector through its terminal turn, counting a
C that is both only once.

[kb-run-prep]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/run-preparation-protocol.md
[kb-summarizer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/compaction-summarizer-and-overflow.md
