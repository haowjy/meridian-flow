# Runtime compaction

How a run compacts: the two delivery transitions around the summary, their
failure, cancel, and recovery rules, cost, the trigger and size estimate, the
summarizer, document-text elision, and context-window overflow recovery.

## Two delivery transitions

Compaction is two delivery transitions around an unlocked
`ConversationSummarizer` call. No lock is held while the summary runs.

1. **Reservation commit.** The boundary's own preparation commit reserves
   pending C instead of an assistant turn. Both reservation sites build the
   turn with `reservationTurn`, including the decision's trigger. An
   impossible tail (the summary reserve, pinned request, and minimal suffix already
   reach the fit limit) reserves no C and fails as a preparation failure.
2. **Summary.** `compaction-phase.ts` runs the summarizer, then prepares a
   live rebake over a provisional completed C before preparing late
   arrivals. `composeLivePromptBake` serves initial bakes and rebakes alike.
   Reference reads during this prepare belong to C; B does not exist until
   commit.
3. **Successor commit.** `compaction-successor.ts` returns one retry-local
   usable or failed value, and the delivery adoption carries it into its
   explicit placeholder completion mode. The commit joins `beginPromptEpoch`,
   adoption, notice consumption, and B's reservation. A moved leaf repeats
   only successor preparation, never the summary.

The complete summary block is immutable. Its fit limit comes from the
decision, independently of the automatic trigger. A usable value's token
count describes the compacted base before late arrivals. Summary responses
never supply the conversation token baseline.

The usable prepared value carries metadata (the placeholder's reservation
metadata plus `elisions`) into provisional assembly. The commit reloads C after
paid-summary settlement and passes `{ ...settled.metadata, ...prepared.metadata }`
to `beginPromptEpoch`: settlement appends summarizer telemetry to C, so passing
the prepared value alone would drop it. Telemetry never renders to the model, so
B's first request still equals the rebuild. The same assembly measures
`tokensAfter`; the epoch, frozen elisions and successor commit atomically.

## Document-text elision

The writer transcript stays intact. A completed compaction owns frozen
`metadata.elisions` (block ID, treatment, affected URIs, replacement content).
`projectActiveHistory` substitutes only its retained tail and pinned request,
not later arrivals. Reverted, failed, pending and superseded owners do not apply.
Forks inherit this metadata only when their cutoff includes the owner.

`ToolRegistration.documentText` owns each tool's classification and replacement
copy. `write` and `search` register policies; references use `reference-context`.
Error pairs are outside the policy. Explicit empty `documentRevisions` means no
document text; absent evidence, null tokens and failed lookups fail closed.
`diff` always elides. Tool pairing, reasoning, writer words and fresh text stay.

Successor prepare independently queries current document revisions once per
attempt and plans from raw retained blocks, never from a previous owner's
replacements. A moved leaf re-queries, while a failed prepare writes no elisions.
The loop asserts no response scope is open: `DocumentRevisions.current` cannot
represent response-staged overlays. Query failures become unknown tokens; the
assertion is an invariant failure, not a lookup failure.

## Image re-admission

Complete compaction is the explicit image-budget rebalance seam. It first
projects late arrivals with the normal chronological eviction rule, then
resolves retained excluded candidates and admits them newest-first only into
remaining budget. Candidates never evict existing inclusions; definite missing
assets and transient resolution failures leave their prior decisions unchanged,
while unexpected resolution errors still fail preparation.

Re-admission decisions belong to C, so reverting C removes their effect and a
fork copies them only when its cutoff includes C. `tokensAfter` measures the
prepared request; successor commit rechecks fit after late arrivals and guards
against overflow.

## Failure landing

- A failed summary errors C and fails a reply below the latest message.
- A usable epoch still commits when a late arrival fails context preparation,
  including an oversized late paste; only B fails.
- A live unexpected error while C is current uses a fresh failure
  transaction: C `error`, settled summary rows, failed B below the latest
  arrivals, and receipt acknowledgment. Notices remain queued.
- If that transaction also fails, orphan recovery owns C and this run makes
  no further settlement attempt. Paid rows still in memory are uncommitted
  and the orphan finalizer cannot recover them, exactly as at a process
  crash. They are not debited; a later delivery may need another provider
  call.

## Current turn and cancellation

The lease does not copy the current turn's kind: `currentTurnKind(turn)`
derives `assistant` or `compaction` from the referenced turn's role. Writer
admission returns an assistant ID only when the current turn is an assistant.

The lease keeps `bound_turn_ids` for the live run, appended in the same
transaction as each current-turn binding. Stop matches this membership under
the lease update lock, whether it names a predecessor or the newly committed
successor, and whether it reaches the owning process or a remote one.
Membership resets with the next run, so a finished run cannot cancel a newer
lease. The process-local session keeps no second membership map. Remote
cancellation reaches the local signal through the lease heartbeat as well as
boundary checks.

Only the run signal or the durable cancel request authorizes cancellation. A
summarizer that returns `cancelled` on a live signal has failed, and an
internal `AbortError` alone is not Stop. Stop aborts the summary, and terminal
close settles its response rows on cancelled C with the receipt
acknowledgment. Late arrivals are not part of C's receipt and stay queued for
the cancel wake.

## Placeholders and recovery

A pending placeholder is a turn with status `pending` and a role in
`PENDING_PLACEHOLDER_ROLES` from `@meridian/contracts/threads` (today only
`compaction`); a pending assistant turn is not one. Test with
`isPendingPlaceholder` or the database's `pendingPlaceholderPredicate`, never a
local role or status check.

Run start finalizes stale pending placeholders before selection, using the
new run's own held claim. The orphan-repair lane also scans indexed pending
placeholders, so quiet primary threads recover without a new wake; child
reports are finalized on C and published after releasing the child's lock. A
late writer message stays unacknowledged and is redelivered rather than
receiving a synthetic failed reply.

## Cost

`settleSummaryResponses` writes predictions, request sizes, and debits through
`TurnAccounting.computeAndDebit` inside whichever transaction ends C.
Retrying settlement does not count the paid call twice in the shared tree
budget. A child report's cost sums every assistant and compaction response
from its selector through its terminal turn, counting a C that is both once
(`execution-finalizer.ts`).

## Trigger and size estimate

`loop/request-preparation.ts` measures the assembled request and plans against
raw history. The token baseline comes from the cache service's
reusable-prefix selection with TTL ignored; missing or zero usage estimates
the whole request. Without an explicit Agent limit, the trigger is
floor(90% × min(input pricing tier ?? usable window, usable window)), capped
at 400,000 tokens. Explicit Agent token and percentage limits are not scaled.
Mars defines no off switch. The estimator excludes elision payloads from C's
header because only the summary renders there.

| Models | Default trigger tokens |
|---|---:|
| Sonnet 4 (direct and OpenRouter) | 165,254 |
| Sonnet 4.6, GPT-4.1, GPT-4.1 mini, Gemini 2.5 Flash, DeepSeek V4 Flash | 400,000 |
| Haiku 4.5 | 122,400 |
| Claude 3.5 Haiku | 172,627 |
| GPT-4o (direct and OpenRouter), GPT-4o mini | 100,454 |

### CJK estimator rates

Each registry model carries a required tokenizer family (`anthropic`, `o200k`,
`gemini`, or `deepseek`). The estimator requires the request model's family;
there is no fallback family. One constant for every family is wrong: 3.0
overcounts DeepSeek about four times, and 0.8 undercounts Claude about three.

| Tokenizer family | Rate (tokens / CJK code point) | Basis |
|---|---:|---|
| `anthropic` | 3.0 | Conservative placeholder above a small published ~2.3 sample (range to 2.5); not measured locally. [Carwash methodology](https://carwashtest.org/methodology.html), [Anthropic token-counting guidance](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/token-counting.md). |
| `o200k` | 1.1 | Offline `tiktoken` `o200k_base` count of the committed CJK corpus: 1,827 tokens / 1,882 Han points = 0.9708; add 10% headroom and round up to a tenth. Published sample is ~1.0; encoding mapping: [OpenAI `tiktoken` model map](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py), [Carwash methodology](https://carwashtest.org/methodology.html). |
| `gemini` | 1.2 | Low-confidence placeholder over a published ~0.8 sample; Google’s general character heuristic is not Chinese-specific. [Google token guide](https://ai.google.dev/gemini-api/docs/tokens), [Carwash methodology](https://carwashtest.org/methodology.html). |
| `deepseek` | 0.8 | A live V4 Flash corpus measured 0.69; 0.8 adds headroom. It is near DeepSeek’s published ~0.6 general guidance. [DeepSeek token usage](https://api-docs.deepseek.com/quick_start/token_usage/). |

Refresh rates with `pnpm --filter @meridian/server exec tsx
scripts/probe-compaction-estimates.ts`. The probe reports each reachable
provider against its declared family and a per-family recommendation with 10%
headroom, using `apps/server/scripts/fixtures/compaction-estimator-probe.json`.

## Summarizer

`summary/conversation-summarizer.ts` implements the port in production. Warm
sends the request in hand with an appended system-origin instruction and a
lower output cap (summary reserve plus thinking budget); it never raises the
cap or changes other fields. Any unusable warm response or provider failure
runs cold once; Stop does not. Both attempts return their rows for
settlement. Cold uses `COMPACTION_SUMMARIZER_MODEL` (default DeepSeek Flash),
or the retained thread model when that provider is disabled. Its prediction is
always `cold/summary_transcript`, not the thread prefix's prediction.

Before summarization, one settled-authority revision query over the active
projection (the history the summarizer reads, not only the planned cut) supplies
only the changed URIs in the appended instruction. Warm requests keep their
prefix unchanged.

Cold receives only the cut blocks and prior summary, excluding the retained
pin and tail. It renders model-visible custom content, omits opaque
reasoning and thinking, and labels prior context. Before any cold call, all
turns are measured. Oversized turns replace re-readable tool bodies with a
URI and short excerpt, then split at block boundaries if needed. An oversized
indivisible block fails before any cold call. Rolling segments carry the
running summary forward and reserve its provider-token output cap
independently of the CJK request estimator, then recheck each assembled
request against the usable window. Prompts preserve exact story terminology,
quoted writer wording, and per-document done and pending edits; they forbid
invented facts.

Output-limit failure uses the provider finish reason, not an input-token
estimate; the successor fit check still measures the full assembled request.
Every attempted call returns its row, prediction, and message count, even when
a later segment fails or Stop aborts it. Summarizer adapters never throw after
a paid call; unexpected throws are error-level events. Settlement records
path and segment metadata and charges those rows only in the transaction
ending C.

## Context-window overflow

The gateway normalizes provider context-window failures to `context_overflow`.
The loop completes A at its last persisted tool group (empty is legal), then
prepares a forced `compact` decision with a cold path and a fit limit from the
resolved usable window. It retries generation once per reply, not once per
tool iteration; a split adopting new input renews that budget, while the
compaction successor preserves it. A second overflow fails with
`context_window_exceeded` and acknowledges the receipt rather than re-sweeping
the same request. Metered output from an overflow is billed without retaining
the incomplete response's blocks. The WebSocket live-state codec accepts
`compacting` so a client can join while C is pending.
