# Runtime compaction

How a run shrinks its history: a compaction placeholder C is reserved at a run
boundary, an unlocked summary call writes the summary, and a successor commit
opens a new prompt epoch with the summary, the pinned requests, and a recent
tail. The summary call itself is the [summarizer](summarizer.md). Manual
`/compact` is selected at run start under the [control queue](controls.md), and stale document text in the retained tail
is [elided](document-text.md). Orphaned C is repaired by
[recovery](recovery.md). Rationale: the KB's
[run preparation protocol][kb-run-prep] and
[summarizer and overflow][kb-summarizer] records.

| File (under `loop/`) | Role |
|---|---|
| `compaction/trigger.ts` | Resolves the trigger: explicit Agent limits, else the pricing-aware default. |
| `compaction/estimate.ts` | The shared per-part estimator for planner defaults and request estimates. Every estimate receives the model's required tokenizer family, including turn planning and summary segmentation. Image parts use 1,600 tokens; file text uses the greater of its visible-string estimate or a 10,000-token floor. |
| `compaction/plan.ts` | Takes the raw effective transcript, reserves overhead and every unanswered directed request plus the newest writer request (`pinnedRequestTurnIds`), and limits later cuts to after the active compaction's cut. A missing pinned request yields an explicit `no_compaction` plan, never persistable metadata. |
| `compaction/tail.ts` | The shared ordered projection rule; lifts pins in order when the cut removes them. |
| `compaction/decision.ts` | One boundary's compaction choice, its refusals, and C's failure errors. |
| `compaction/project.ts` | Strictly decodes complete compactions, requires every pinned turn to exist, and projects the summary under the owning thread ref. |
| `compaction/elide.ts` | Plans stale document-text replacements ([document text](document-text.md)). |
| `request-preparation.ts` | Measures the assembled request and decides against raw history. |
| `compaction-phase.ts` | Runs the unlocked summary, then prepares values for the successor. |
| `compaction-successor.ts` | Retry-local successor values and the placeholder completion transaction. |

`compaction/index.ts` is the pure core's public surface. History-item metadata
classification and every turn codec, C's included, live in
`threads/domain/turn-metadata.ts`.

## Two delivery transitions

Compaction is two delivery transitions around an unlocked
`ConversationSummarizer` call. No lock is held while the summary runs.

1. **Reservation commit.** The boundary's own preparation commit reserves
   pending C instead of an assistant turn. Both reservation sites build the
   turn with `reservationTurn`, including the decision's trigger. An
   impossible automatic tail (the summary reserve, pinned requests, and minimal
   suffix already reach the fit limit) reserves no C and fails as a preparation
   failure.
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
count describes the compacted base before late arrivals. Only assistant response
rows can supply a reusable baseline; summary rows never supply the conversation
token baseline.

The usable prepared value carries metadata (the placeholder's reservation
metadata plus `elisions`) into provisional assembly. The commit reloads C after
paid-summary settlement and passes `{ ...settled.metadata, ...prepared.metadata }`
to `beginPromptEpoch`: the owner hook `recordCompactionSummary` writes C's
summarizer telemetry during settlement, so passing the prepared value alone
would drop it. C's `controlMessageId` is written when the command is reserved;
another queued command remains for a later run. Telemetry never renders to the
model, so B's first request still equals the rebuild. The same assembly
measures `tokensAfter`; the epoch, frozen elisions and successor commit
atomically.

## Decisions and refusals

A decision is automatic (the trigger), manual (a `/compact` control), or
overflow (a provider context-window failure, below).

Manual decisions fit against the usable window; their tail budget base is
`min(trigger, tokensBefore)`. Automatic and overflow decisions use their fit
limit as the tail budget base. Pins preserve unanswered directed requests and
the newest writer request. Adopted-but-unanswered requests remain pinned. A command starts only after all waiting messages have been adopted by a reply.

A manual decision always plans a cut once the thread has a completed reply. It
uses the normal retained tail when that leaves history to summarize; otherwise it
replans with the minimal tail (only outstanding pins, with tool groups intact).
Thus consecutive manual compactions summarize the prior summary plus everything
after it. The controls route rejects a thread with no completed reply before
enqueue. A minimal tail that does not fit still fails as `context_too_large`.
Optional `/compact` instructions are stored on C and added to both warm-branch
and rolling summarizer prompts. Forking at a completed C inherits that C, so the
fork's active history begins with its summary and retained tail.

The reservation commit consumes a selected compact command by acknowledging
its inbox row with C. A crash after compact starts repairs the already-created
C, and the command is not redelivered. Waiting commands are not part of the
current reservation and remain queued.

## One projection authority

`projectActiveHistoryWithBakes` (`compaction/project.ts`) is the only public
way to project a thread's active history: the latest complete C's summary, its pinned requests, and its retained tail,
with C's frozen elisions applied. It resolves C's own prompt bake before
adding the summary's history-read sentence, so the current registry cannot change an old summary's bytes
([history tools](history-tools.md#history-guidance-follows-the-bake)). The
synchronous projector stays private because, without that bake, it drops the
sentence. Callers: request assembly (`turn-context-assembly.ts`), the summary phase
(`compaction-phase.ts`), and the handoff request (`runtime/handoff/brief-request.ts`). `projectCompactedHistory` narrows a
projection to the cut alone (retained pins and tail removed) for the cold
summary and the manual floor.

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

## Failure landing

- A failed automatic summary errors C and fails the reply below the latest
  message. A failed command summary errors only C; command failures never fail
  a reply.
- Failed C metadata records the typed `reason` and `phase`; a fit rejection also
  records `estimatedTokens` and `fitLimitTokens`. `turn.error` carries the outcome
  in its details. Summary rejections use code `compaction_failed` while their
  reasons distinguish `max_tokens`, `request_too_large`, `provider_error`,
  `tool_use`, and `empty_text`;
  unknown summary errors stay `compaction_failed`. Orphan recovery uses the same
  metadata writer with `reason: interrupted` and `phase: recovery`, both at run
  preparation and during the primary/child startup sweep. These codecs belong to C; the handoff seed's typed outcome is separate ([handoff](handoff.md)).
- Late arrivals get B's own request preflight. It may compact again when the
  normal plan can fit them; if the request is over the automatic trigger but
  still fits the model's usable window and cannot be compacted below the
  trigger, it proceeds without failing B. Only a request that cannot fit the
  usable window fails B with `context_too_large`; C still commits its summary
  and prompt epoch, and paid summary rows settle successfully with C.
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
acknowledgment. Late arrivals are not part of C's receipt and remain pending
for the post-release queue reread or the periodic wake sweep.

## Context-window overflow

The gateway normalizes provider context-window failures to `context_overflow`.
The loop completes A at its last persisted tool group (empty is legal), then
prepares a forced `compact` decision marked `knownTooLarge` with a fit limit
from the resolved usable window. The shared summary rule selects rolling for a
known-too-large request. It retries generation once per reply, not once per
tool iteration; a split adopting new input renews that budget, while the
compaction successor preserves it. A second overflow fails with
`context_window_exceeded` and acknowledges the receipt rather than re-sweeping
the same request. Metered output from an overflow is billed without retaining
the incomplete response's blocks. The WebSocket live-state codec accepts
`compacting` so a client can join while C is pending.

## Image re-admission

Complete compaction is the explicit image-budget rebalance seam. It first
projects late arrivals with the normal chronological eviction rule, then
resolves retained excluded candidates and admits them newest-first only into
remaining budget. Candidates never evict existing inclusions; definite missing
assets and transient resolution failures leave their prior decisions unchanged,
while unexpected resolution errors still fail preparation. Keep the late-arrival
pass first: with candidates first, a re-admitted image took room a new image
then needed, so the new image evicted an included one and the pass wrote a
removal notice for an image that was never removed. Candidates are never
eviction victims, and each block is decided at most once per pass.

Re-admission decisions belong to C, and a fork copies them only when its cutoff
includes C. `tokensAfter` measures the
prepared request; B runs its own preflight after late arrivals and can compact
again or proceed under the usable window.

## Cost

Summary rows settle through the [summarizer](summarizer.md#paid-rows-and-settlement)
in whichever transaction ends C. A child report's cost sums every assistant
and compaction response from its selector through its terminal turn, counting
a C that is both once (`execution-finalizer.ts`).

[kb-run-prep]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/run-preparation-protocol.md
[kb-summarizer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/compaction-summarizer-and-overflow.md
