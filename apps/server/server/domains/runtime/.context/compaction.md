# Runtime compaction

Compaction reserves a placeholder C at a run boundary, performs one unlocked
summary step, then commits a successor that opens a prompt epoch. The summary
call is the shared [summarizer](summarizer.md); orphan C is repaired by
[recovery](recovery.md). Manual `/compact` is selected at run start under the
[control queue](controls.md), and stale document text is [elided](document-text.md).
Rationale: the [run preparation protocol][kb-run-prep] and
[summarizer/overflow][kb-summarizer] decisions.

## Protocol

Reservation, summary preparation, and successor completion are separate
transitions around the unlocked summary step:

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

## Important files

A summary cannot credit the model with having seen a document, so the successor
re-shows the ones it most needs ([credit scope](document-text.md#observation-frontiers),
owner rulings C10, C12 and C13). The summarizer ends its output with
`## Documents to keep open`, one context URI per line, working-notes files first, then documents most important to the task. `compaction/important-files.ts` owns the instruction and parser. Each listed note
also gets a one-line account in the narrative, not on its exact-match URI line.
`prepareCompactionSuccessor` strips that section and any model-emitted
`## Documents not re-shown` section from the stored summary. Both reserved
headings accept any Markdown heading level, case differences, a trailing colon
and closing hashes. An empty narrative after stripping fails with `empty_text`
through the summary-failure path; documents and the note cannot replace it.
A listed line names a shown URI only by exact match: list markers are removed,
then the line is checked against the shown URIs before each layer of decoration
is peeled (a wrapping backtick, angle bracket or quote; trailing `.,;:`; a
trailing parenthetical), so a name like `Chapter 1 (revised)` keeps its
parenthesis and `Chapter 1.bak` never becomes `Chapter 1`. Matching uses
`documentRevisions` evidence from the **whole pre-compaction history**, not only the retained tail. Unknown URIs are
dropped with `important_file.unknown_uris` (count). Candidates are all
matched entries, then the 3 most recently shown documents, deduplicated by
document id. Missing or malformed lists naturally leave only the 3 recent.

The full text is selected greedily in that order, within
half the headroom between the measured compacted base and the auto-compaction
trigger, less estimator slack, of rendered text using the successor model's tokenizer and shared part estimator,
including the exact projected heading plus read. Before admitting documents,
the picker reserves the longest list it can write (every candidate named),
priced with that same estimator and tokenizer. Each admitted document only
shortens that list. The 1,000-token margin is estimator slack only. When the base
and the reserved list already exhaust trigger headroom, no document is admitted
and the list is empty; this base can remain over the trigger. A document whose
full text exceeds what is left is skipped, never truncated (a truncated copy
would be a partial read with its own listing). There is no count cap or fixed
token budget. Without a trigger there is no limit. Reads stop as soon as the
remaining room is spent; oversized documents are skipped so later smaller
candidates can still fit.

The summary's `## Documents to keep open` section is written from the admitted
reads, in read order, replacing whatever the summarizer listed. The list and the
blocks therefore cannot disagree: a candidate that did not fit, could not be
read, or was never shown is simply absent, and no omission note is written for
the model or the writer.

Each is read in full through the reference reader (`readDocument`, an
omitted-version read, so a draft-mode thread gets its Work draft and auto-apply
gets live) and persisted as a reference-shaped text block with its `read` on the
compaction turn, `sequence` 1 and up beside the summary at 0, most important
first. The next compaction ranks earlier blocks on this turn as more recent:
recorded evidence is inserted backwards for compaction turns because the recent
picker reverses evidence insertion order. Its evidence is
recorded like an @-mentioned document's, by `afterEvents` of the completing
transaction: shown links, and a frontier chained from nothing (a fresh chain). A
document that cannot be read is skipped with a warning
(`important_file.read_failed`); it never fails the compaction. Assembly runs
once without them to size the budget and fail early, then once with them: that
second pass measures `tokensAfter` with the final summary, including any
not-re-shown note, even when no documents fit.
A retried successor preparation reads again; only the completing attempt's
blocks and evidence persist.

The projector puts these blocks on the synthetic summary turn right after the
summary, each as a plain text block (the heading "Current text of <uri>,
re-shown after the summary:" plus the read) that keeps the block's id, and
credits their ids. The completion commit hands its persisted blocks (summary and
re-shown) back on the adopted batch (`completedBlocks`), so the run's in-memory
history holds them for every later request, like any other adopted block. The retained tail's copies of a re-shown document
are elided as `reshown` (`compaction/elide.ts`), so a request carries each
re-shown document once. A later compaction sees these blocks as ordinary
pre-compaction history.

## Decisions and projection

A decision is automatic, manual, or overflow. Pins preserve unanswered
requests and the newest writer request; adopted-but-unanswered requests remain
pinned. Manual compaction requires a completed reply and may use the minimal
tail when the normal tail leaves nothing to summarize. A minimal tail that does
not fit fails `context_too_large`. Instructions are stored on C and apply to
both warm-branch and rolling prompts.

`projectActiveHistoryWithBakes` is the only public active-history projector. It
also returns `creditedBlockIds`: the blocks after the latest complete C plus the
documents C re-showed, or every effective block with no C. Observation
frontiers credit only those ids, so the retained tail before C credits nothing.
It
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
Without an explicit Agent limit, optional registry `compaction.trigger` supplies
either `{ tokens }` or `{ fraction }` of the usable window. Without that override,
the default remains 90% of the lesser of the model's input pricing tier and usable
window. All forms are clamped to the usable window and 400,000 tokens.
Explicit token/percentage limits are not scaled. The estimator excludes
elision payloads from C's header.

An automatic **compact decision**, after ordinary no-fit handling, may first
reserve an ordinary assistant with a hidden `compaction_notes` system marker.
There must be an ordinary model response since the latest complete C, no marker
after that C, and at least two unspent ordinary slots. With full request estimate
E and usable input U, admission requires `U-E-4000 >= 4000`; the growth allowance
is `min(32000, U-E-4000)`. The marker rerender must also fit that allowance and
`U-4000`. No manual/forced overflow attempt enters notes.

The run loop owns the accepted continuation (entry estimate, allowance, at most
`min(3, remaining-1)` generations). Delivery transports the request and continuation
as one opaque prepared payload, returning only the committed proposal. No
preparation mutates loop state. Eligibility checks precede boundaries that may
pay for compaction; only an actual ordinary generation spends an iteration.

Each notes response and all its writes/results settle normally. A no-tools
response, exhausted count, growth at the allowance, or request above `U-4000`
ends the step at a fresh late-inclusive compaction preparation. If pins destroy
the cut, the usual below-U generation/no-fit failure applies, not a stale cut.
Active notes suppress otherwise automatic compaction without resetting room on
late input. Summary successors get one ordinary response before reconsideration.

The sequential dispatch seam holds every non-file or out-of-folder call before
save-boundary/policy work. The injected composition adapter uses the same scoped
variables and canonical thread-folder proof as execution, including copy sources
and explicit search scope. Held results are neutral, not permission denials;
ordinary Agent and file policies still apply to admitted addresses.

The prepared inputs are rendered again with the durable marker suffix, without
re-resolving images or skills. Image updates precede the marker, which commits
atomically with its assistant reservation. Stop/failure never removes that marker
or committed writes. A later run does not reconstruct the run-local continuation.
Raw-history dedup resets only after a complete C, not a failed/incomplete one.

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
