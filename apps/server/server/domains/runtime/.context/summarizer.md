# Summarizer

One `ConversationSummarizer` port (`ports/conversation-summarizer.ts`) serves
both paid summaries: a compaction's C and a handoff's brief on seed S.
`summary/conversation-summarizer.ts` implements it in production. Rationale:
[Compaction Summarizes Warm or Cold][kb-summarizer].

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
keeps its summary bytes.

## Warm, then cold

The path comes from one `prefixCacheStateFor` call on the source's model
([request assembly](request-assembly.md#cache-state-and-cache-hints)); only
`state` chooses it.

**Warm** sends the request in hand plus one appended system-origin
instruction, with the output cap lowered to the summary reserve plus the
thinking budget. It never raises the cap or changes other fields: tools,
`tool_choice`, reasoning, `promptCacheKey`, and cache marks stay as assembled,
so the prefix stays warm. The warm row records the thread model's prediction.

For a compaction, the warm instruction also names what the summary is not
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

Before summarizing, one settled-authority revision query over the active
projection (the history the summarizer reads, not only the planned cut)
supplies the changed URIs, named in the instruction (appended on warm, in the
system prompt on cold). Warm requests keep their prefix unchanged.

Any unusable warm response or provider failure runs **cold** once; Stop does
not. Cold uses `COMPACTION_SUMMARIZER_MODEL` (default DeepSeek Flash), or the
retained source model when that provider is disabled. Every cold row records
`cold/summary_transcript`, never the thread prefix's prediction: its request
does not share the thread's prefix. (A handoff from an older cutoff predicts
`cold/fork_cutoff` for the source, which is why it takes the cold path.)

Cold receives only the cut blocks and prior summary (`projectCompactedHistory`
drops the retained pin and tail). It renders model-visible custom content,
omits opaque reasoning and thinking, and labels prior context. Before any cold
call, all turns are measured. Oversized turns replace re-readable tool bodies
with a URI and short excerpt, then split at block boundaries if needed; an
oversized indivisible block fails before any cold call. Rolling segments carry
the running summary forward and reserve its provider-token output cap
independently of the CJK request estimator, then recheck each assembled
request against the usable window. Prompts preserve exact story terminology,
quoted writer wording, and per-document done and pending edits; they forbid
invented facts.

Output-limit failure uses the provider finish reason, not an input-token
estimate; the successor fit check still measures the full assembled request.

## Paid rows and settlement

Every attempted call returns its row, prediction, and message count, even when
a later segment fails or Stop aborts it. Adapters never throw after a paid
call; unexpected throws are error-level events. Summary rejections share one
contract reason set (`SummaryRejectionReason` in `@meridian/contracts/runtime`:
`max_tokens`, `provider_error`, `tool_use`, `empty_text`); each owner composes
its own failure phases.

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
