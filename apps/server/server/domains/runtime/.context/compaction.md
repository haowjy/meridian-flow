# Runtime compaction

Compaction reserves a placeholder C at a run boundary, performs one unlocked
summary call, then commits a successor that opens a prompt epoch. The summary
call is the shared [summarizer](summarizer.md); orphan C is repaired by
[recovery](recovery.md). Manual `/compact` is selected at run start under the
[control queue](controls.md), and stale document text is [elided](document-text.md).
Rationale: the [run preparation protocol][kb-run-prep] and
[summarizer/overflow][kb-summarizer] decisions.

## Optional Scratch update

Before eligible automatic compaction, the loop may append a durable
`compaction_notes` system update and let the ordinary response loop make at most
three **tool calls total**. Scratch is shared working state, not a second
continuation summary: no handoff file, reserved folder, or ownership change.
A tool-free response goes straight to the normal summary. Reads, listings,
searches and writes count, including failed, denied and out-of-scope attempts.
Surplus calls and non-Scratch operations persist a neutral `notes_step` held
result and never execute or replay. Ordinary permissions and response-save
transactions still apply. Held results are not document evidence, edits, errors
or successful receipts, including in compaction and `thread_history` projections.

Admission needs a prior assistant response in this prompt epoch, two remaining
model iterations under both the local cap and shared tree-turn budget, and input headroom for another output reserve. Manual and
forced overflow compaction bypass the step. A result that exhausts optional headroom ends it. The forced summary uses the
actual input window as its fit limit, not the lower automatic trigger; the
trigger still sizes the preferred retained tail. An indivisible pinned tail
that exceeds the real window remains an ordinary context-too-large failure. A committed marker prevents Retry or
process recovery from reopening the allowance in the same epoch. No marker is
installed before the prepared boundary commits. The summary is due after the
step even if the next estimate falls below the trigger. Normal cancellation,
credit, tree and iteration budgets govern every additional model request.

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

## Important files

A summary cannot credit the model with having seen a document. The successor
re-shows useful reads through the ordinary read path
([credit scope](document-text.md#observation-frontiers)). The summarizer ends with
`## Documents to keep open`, one JSON object of ordinary `read` arguments per
line, most important first. `compaction/important-files.ts` publishes the actual
read schema and validates with `ReadToolInputSchema`; there is no separate
selector grammar. All read arguments retain their ordinary meaning, including
`around`, `format`, `before`, and `version`.

Both this heading and model-emitted `Documents not re-shown` sections are removed
before storing the narrative (any heading level, case, trailing colon/closing
hashes). An empty remaining narrative fails with `empty_text`. Only admitted
reads regenerate the keep-open list; no omission inventory is written.

Candidates bind to document identities shown in the whole pre-compaction
history, not arbitrary paths. Listed reads rank first, then the three recently
shown identities as default `{path}` reads. Paths use the ordinary filename/URI
normalization; fragments remain part of the read input. First listed identity
wins. Even schema-invalid input with an identifiable shown path claims its
identity, preventing a recent whole read from silently replacing it. Malformed
JSON without an identifiable path is ignored; recent selection remains
independent. Failed and oversized reads are omitted, never retried with broader
arguments or resurrected by recent selection.

The picker reserves the complete candidate list, then admits whole read results
greedily within half the trigger headroom after the compacted base, minus
1,000 tokens of estimator slack. It uses the successor model's tokenizer and
shared part estimator for the exact JSON-labelled wrapper also used by
projection. Oversized reads are skipped so later smaller reads can fit; no
truncation, count cap, or fixed budget. No trigger means no budget limit.

`referenceReader` and the ordinary read handler share one tracked-document read
operation. It resolves the same version and grant (including explicit retained
draft reads), checks the expected document identity, and calls `readDocument`.
Successful reads with empty observation evidence, such as edits listings, are
still results. There is no manufactured full-text credit for outlines or edits.
Exceptions other than cancellation log `important_file.read_failed` and omit
that read; cancellation escapes immediately.

Each admitted read persists on C after the summary as a reference snapshot with
its result, revision and actual `read.input`. The input is opaque display JSON
in shared contracts, never executable on replay, and never accepted in writer
submissions. The admitted list, projected label and budget wrapper use that same
JSON. Ordinary attached references may omit input and use their canonical path.
The projector retains block IDs, so completion records shown links and fresh
observation frontiers against those exact blocks. Only the winning completion
transaction records evidence; discarded preparations, failures and omissions do
not. The completed blocks join in-memory history for all later requests.

Only admitted default-version whole reads (no fragment, `in`, `around`, or
non-full format) authorize full-copy `reshown` elision. Explicit `format: full`
counts as whole; explicit versions conservatively do not replace the thread's
effective-version text. Partial reads leave unchanged full tail copies visible,
but those pre-compaction copies credit nothing after C. Outside selected blocks
remain unshown, so ordinary region-change checks still apply to later edits.
A later compaction treats these blocks as ordinary prior history; recent
selection does not inherit old read arguments.

Assembly first sizes the compacted base, then measures the final summary and
admitted reads, even when none fit. A retried successor preparation reads again;
only its completing attempt's snapshots and evidence persist.

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
