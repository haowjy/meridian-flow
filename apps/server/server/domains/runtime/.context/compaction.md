# Runtime compaction

This file covers runtime autocompaction triggers, estimation, and delivery
boundaries. It also covers summarization, overflow recovery, cancellation,
placeholder recovery, and cost.

## CJK estimator rates

Each registry model carries a required tokenizer family (`anthropic`, `o200k`,
`gemini`, or `deepseek`). The estimator requires the request model's family;
there is no fallback family.

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

## Compaction request boundaries

`loop/request-preparation.ts` measures the assembled request and plans against raw
history. The token baseline comes from the cache service's reusable-prefix
selection with TTL ignored; missing/zero usage estimates the whole request.
Without an explicit Agent limit, the trigger is floor(90% × min(input pricing
tier ?? usable window, usable window)), capped at 400,000 tokens. Explicit Agent
token and percentage limits are not scaled. Mars defines no off switch.

| Models | Default trigger tokens |
|---|---:|
| Sonnet 4 (direct and OpenRouter) | 165,254 |
| Sonnet 4.6, GPT-4.1, GPT-4.1 mini, Gemini 2.5 Flash, DeepSeek V4 Flash | 400,000 |
| Haiku 4.5 | 122,400 |
| Haiku 3.5 | 172,627 |
| GPT-4o (direct and OpenRouter), GPT-4o mini | 100,454 |

`summary/conversation-summarizer.ts` implements the port in production. Warm
sends the request in hand with an appended system-origin instruction and a lower
output cap (summary reserve plus thinking budget), never increases its cap or
changes its other fields. Any unusable warm response or provider failure runs
cold once; Stop does not. Both attempts return their rows for settlement.
Cold uses `COMPACTION_SUMMARIZER_MODEL` (default DeepSeek Flash), or the retained
thread model when that provider is disabled. Its prediction is always
`cold/summary_transcript`, not the thread prefix's prediction.

Cold receives only the cut blocks and prior summary, excluding the retained pin
and tail. It renders model-visible custom content, omits opaque reasoning and
thinking, and labels prior context. Before any cold call, all turns are measured.
Oversized turns replace re-readable tool bodies with a URI and short excerpt,
then split at block boundaries if needed. An oversized indivisible block fails
before any cold call. Rolling segments carry the running summary forward and
reserve its provider-token output cap independently of the CJK request estimator,
then recheck each assembled request against the usable window. Prompts preserve exact
story terminology, quoted writer wording and per-document done/pending edits;
they forbid invented facts.

Output-limit failure uses the provider finish reason, not an input-token estimate;
the successor fit check still measures the full assembled request.
Every attempted call returns its row, prediction and message count, even when a
later segment fails or Stop aborts it. Settlement records path/segment metadata
and charges those rows only in the transaction ending C.

The gateway normalizes provider context-window failures to `context_overflow`.
The loop completes A at its last persisted tool group (empty is legal), then
prepares a forced `compact` decision with a cold path and an independent usable
window fit limit from the resolved usable window. It retries generation once per
reply (not once per tool iteration); a split adopting new input renews that
budget, while the compaction successor preserves it. A second overflow fails with
`context_window_exceeded` and acknowledges the receipt rather than re-sweeping
the same request. Metered output from an overflow is billed without retaining
the incomplete response's blocks. The WebSocket live-state codec accepts
`compacting` so a client can join while C is pending.

Compaction is two delivery transitions around an unlocked `ConversationSummarizer`
call. The first reserves pending C instead of an assistant. `compaction-phase.ts`
then prepares a live rebake over provisional completed C before late arrivals.
compaction-successor.ts returns one retry-local usable/failed value; the delivery
adoption carries that value into its explicit placeholder completion mode. The
complete summary block is immutable, and its fit limit comes from the decision,
independently of the automatic trigger. A usable value's token count describes
the compacted base before late arrivals. Its successor commit joins `beginPromptEpoch`, adoption, notice consumption and B's
reservation. A moved leaf repeats only successor preparation, never summarization.
An impossible tail reserves no C. A failed summary errors C and replies below the
latest message. A live unexpected error while C is current uses a fresh failure
transaction: C error, settled summary rows, failed B below the latest arrivals,
and receipt acknowledgment. Notices remain queued. If that transaction also
fails, orphan recovery owns C; this run makes no further settlement attempt.
Paid rows still in memory are uncommitted and cannot be recovered by the orphan
finalizer, exactly as at a process crash. They are not debited; a later delivery
may need another provider call. A usable epoch still commits when a late arrival fails context
preparation (including an oversized late paste); only B fails. `composeLivePromptBake` serves initial bakes and rebakes
alike. Reference reads during this prepare belong to current C; B does not exist
until commit. Summary responses never supply the conversation token baseline.

The lease does not copy current-turn kind; currentTurnKind(turn) derives
assistant or compaction from the referenced turn's role. Both reservation sites use
reservationTurn, including the decision's trigger. The lease retains bound_turn_ids for this live run, appended in the same
transaction as each current-turn binding. Stop matches this membership under
the lease update lock, whether it names a predecessor or the newly committed
successor and whether it reaches the owning process or a remote process.
Membership resets with the next run, so a finished run cannot cancel a newer
lease. The process-local session does not keep a second membership map. Writer admission returns an assistant ID only for the former. Stop
aborts the summary, and terminal close settles its response rows on cancelled C
with the receipt acknowledgment. settleSummaryResponses writes predictions,
request sizes and debits through TurnAccounting.computeAndDebit inside whichever
transaction ends C. Retrying settlement does not count the paid call twice in
the shared tree budget. Late arrivals are not part of C's receipt and
remain queued for the cancel wake. Remote cancellation reaches the local signal
through the lease heartbeat as well as boundary checks. Only the run signal or
durable cancel request authorizes cancellation: a returned cancelled summary
on a live signal is failed, and an internal AbortError alone is not Stop.
Summarizer adapters return every attempted paid response in their outcome and
never throw after a paid call; unexpected throws are error-level events.

A pending placeholder is a turn with status `pending` and a role in
`PENDING_PLACEHOLDER_ROLES` from `@meridian/contracts/threads` (today only
`compaction`); a pending assistant turn is not one. Test with
`isPendingPlaceholder` or the database's `pendingPlaceholderPredicate`, never a
local role or status check.

Run start finalizes stale pending placeholders before selection using the new
run's own held claim. The orphan-repair lane also scans indexed pending
placeholders, so quiet primary threads recover without a new wake; child reports
are finalized on C and published after releasing the child's lock. A late writer
message stays unacknowledged and is redelivered rather than receiving a synthetic
failed reply. A child report's cost sums every assistant and compaction response from its
selector through its terminal turn, counting a C that is both once
(`execution-finalizer.ts`).
