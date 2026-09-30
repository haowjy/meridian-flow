# Summarizer

One `ConversationSummarizer` port (`ports/conversation-summarizer.ts`) serves
both paid summaries: a compaction's C and a handoff's brief on seed S.
`summary/conversation-summarizer.ts` implements it in production. Rationale:
[Compaction Chooses Branch or Rolling Once][kb-summarizer].

## Owner and source

Every call names an `owner` and a `source`:

- **owner** (`{ threadId, turnId }`): the turn whose response rows and gateway
  correlation the call produces. Compaction: the thread and C. Handoff: the
  destination and S.
- **source** (`{ threadId, throughTurnId? }`): the thread (and optional cutoff)
  whose binding, model, cache, and transcript are summarized. Compaction
  passes the owner's thread; a handoff passes the cutoff owner and cutoff.

The caller supplies the source projection. Both callers build it with
`projectActiveHistoryWithBakes`, the one projection authority
([compaction](compaction.md#one-projection-authority)), so a compacted source
keeps its summary bytes. Both callers collect document revision evidence over
that same projection and append changed document URIs to the summary prompt.

## One branch-or-roll rule

The summarizer chooses exactly once before the provider call, with the same rule
for every source model (`summary/summary-path.ts`):

1. A request known to be too large rolls. This covers the reply that just
   overflowed and the previous settled summary attempt being rejected as too
   large.
2. Otherwise, a warm cache branches on the source-shaped request.
3. Otherwise it rolls. Cold cache is not split by model price.

Both compaction and handoff use this rule. There is no caller-selected path or
branch-to-rolling fallback. Any provider rejection or rolling-segment failure
ends that attempt. Rolling uses the configured cheap summarizer, or the source
model when none is configured. A request-preparation failure is a final failure
before the call, not a reason to try rolling.

**Branch** sends the request in hand plus one appended system-origin
instruction. It keeps the source request's fields unchanged, including an
explicit output limit or its absence. It does not change other fields: tools,
`tool_choice`, reasoning, `promptCacheKey`, and cache marks stay as assembled.
The response row records the source model's cache prediction, including a cold
prediction. For a handoff, the appended instruction names the incoming Agent,
quotes an unanswered writer request under `Open request`, and says not to
answer it.

For a compaction, the branch instruction also names what the summary is not
replacing (issue [#619][i619]): the plan's retained pins and tail, each
passage identified by role and a quoted opening of up to 200 characters,
rendered from the active projection (tool-result openings include call IDs;
assistant passages start with text or a tool call). A passage is a rendered
message, not a turn: adjacent user messages can merge, and one assistant turn
can render several messages, which is what lets a cut fall inside an
assistant tool group. Preservation rules apply only to the replaced material;
the summary must not restate retained passages, cite documents, requests, or
facts found only there, or use a retained reply as proof a replaced request
was done. Handoff briefs have no retained tail and keep their own
instruction.

Before either summary, one settled-authority revision query over the source
projection (the history the summarizer reads, not only a compaction's planned
cut) supplies the changed URIs, named in the instruction (appended on warm, in
the system prompt on cold). Warm requests keep their prefix unchanged.

Rolling uses `COMPACTION_SUMMARIZER_MODEL` (default DeepSeek Flash), or the
retained source model when that provider is disabled. Each rolling row records
`rolling/summary_transcript`, not the thread-prefix prediction. A handoff's
older-cutoff prediction is truncated to the cutoff's ancestor chain: responses
from abandoned sibling branches or descendant turns cannot make it appear
warm.

Rolling receives only the cut blocks and prior summary (`projectCompactedHistory`
drops the retained pin and tail). It renders model-visible custom content,
omits opaque reasoning and thinking, and labels prior context. Before any cold
call, all turns are measured. Oversized turns replace re-readable tool bodies
with a URI and short excerpt, then split at block boundaries if needed; an
oversized indivisible block fails before any cold call. Rolling segments carry
the running summary forward. Compaction and handoff use the same fixed
fiction-oriented sections for objective, document work state, story canon,
decisions, user preferences, open questions, and the next step; handoff alone
adds the open request. The instruction explicitly merges an earlier summary,
uses the writer's language, and treats transcript content as source material
rather than instructions. The request sets no output limit: OpenAI-compatible
adapters leave the provider default in place, while Anthropic supplies its
required registry maximum. Segment budgeting leaves input room for a maximum
length running summary independently of the CJK request estimator, then
rechecks each assembled request against the usable window. Prompts preserve
exact story terminology, quoted writer wording, and per-document done and
pending edits; they forbid invented facts and require concise bullets without
imposing a second token limit.

Output-limit failure uses the provider finish reason, not an input-token
estimate; the successor fit check still measures the full assembled request.
Late arrivals that make the successor too large do not fail C: the reply below
it fails its ordinary fit check.

## Paid rows and settlement

Every attempted call returns its row, prediction, and message count, even when
a later segment fails or Stop aborts it. Adapters never throw after a paid
call; unexpected throws are error-level events. Summary rejections share one
contract reason set (`SummaryRejectionReason` in `@meridian/contracts/runtime`:
`max_tokens`, `request_too_large`, `provider_error`, `tool_use`, `empty_text`);
gateway `context_overflow` maps to `request_too_large`. Each owner composes its
own failure phases. Handoff seed metadata records the one attempted path,
`branch` or `rolling`.

`settleSummaryResponses` (`loop/settle-summary-responses.ts`) writes
predictions, request sizes, and debits through `TurnAccounting.computeAndDebit`
inside whichever transaction ends the owner. It is metadata-neutral: C records
its summarizer telemetry through `recordCompactionSummary` and
`CompactionMetadataCodec`; S through `recordHandoffSeedOutcome` and
`HandoffSeedMetadataCodec`. Retrying settlement does not count a paid call
twice in the shared tree budget. Summary calls spend no model iterations or
turn budget; the next pre-iteration check sees an exhausted tree cost budget.
Summary rows never supply prefix warmth or a token baseline.

Paid rows still held only in memory when a process dies are lost and not
debited ([recovery](recovery.md)).

[kb-summarizer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/compaction-summarizer-and-overflow.md
[i619]: https://github.com/haowjy/meridian-flow/issues/619
