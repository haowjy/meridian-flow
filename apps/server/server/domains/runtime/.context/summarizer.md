# Summarizer

One `ConversationSummarizer` port serves both paid summaries: compaction C and
handoff seed S. Callers provide an owner and a source projection; both use
`projectActiveHistoryWithBakes` so the summary reads the same frozen history as
the runtime. Rationale: [branch or rolling once][kb-summarizer].

## Owner, source, and path

The owner is the turn whose response rows and gateway correlation are produced;
the source is the thread and optional cutoff being summarized. Compaction owns C
and uses its thread; handoff owns S and uses the cutoff owner's thread.

The path is chosen exactly once before the provider call:

1. known-too-large requests roll;
2. otherwise warm cache branches on the source-shaped request;
3. otherwise cold cache rolls.

There is no caller-selected path or branch-to-rolling fallback. Preparation or
provider rejection is final for that attempt. Branch requests preserve source
fields, including output limit, tools, tool choice, reasoning, cache key, and
marks; they add only the summary instruction. Handoff branch instructions keep
open writer requests unanswered.

Rolling uses the configured cheap model or source model fallback and receives
only the cut plus prior summary. It omits opaque reasoning, carries a running
summary through segments, and fails before a cold call when an indivisible block
cannot fit. Compaction retains pins/tail outside the cut; handoff has no
retained tail. Both use a fixed spine of sections (Objective, Work state,
Decisions, User preferences, Open questions, Next step) and ask the model to add
the sections its work needs (a story's canon, research sources, code interfaces),
preserve the user's terminology, and treat transcript text as source material
rather than instructions.

Compaction alone ends its summary instruction with `## Documents to keep open`:
one context URI per line, working-notes files first, then documents most important to the task, with a scratch-first example
(`loop/compaction/important-files.ts` owns the format and its parser). The warm
branch's retained-scope rule exempts this section, so documents shown only in the
retained tail can be listed; the rolling path sees only the cut, and the server's
3 most recent documents cover the tail there. Only the appended instruction
changes: the cached request prefix (messages, tools, system and cache key) does
not. Handoff is unchanged. What successor preparation does with the list is in
[compaction](compaction.md#important-files).

Before either path, one settled-authority revision query over the source
projection supplies changed document URIs. Summary rows do not supply prefix
warmth or a token baseline. Late arrivals are fit-checked by the successor and
fail the ordinary reply when they exceed the usable window; they do not fail C.

## Stray tool calls

Both paths keep nonempty summary text even when the response also contains tool
calls; no tools execute. Output-limit and provider errors still reject the response.
A warm-branch response containing calls but no text gets one retry on the same
request, followed by the returned assistant content (including reasoning) and
one tool message answering every call with an error: "Tools are unavailable
during compaction. Write the summary now, as text." A second response without
text fails `tool_use`. Both attempts remain in `modelResponses` for settlement,
including on failure or cancellation. The retry preserves the source tool
definitions and all other request fields.

The rolling path declares no tools and never retries tool-only output; it fails
`tool_use`. Empty output without calls fails `empty_text` on an initial call.

## Paid rows and settlement

Every attempted call returns its response row, cache prediction, and message
count even if a later segment fails or Stop aborts it. Rejections share the
`SummaryRejectionReason` contract (`max_tokens`, `request_too_large`,
`provider_error`, `tool_use`, `empty_text`); provider `context_overflow` maps to
`request_too_large`.

`settleSummaryResponses` writes predictions, request sizes, and debits through
`TurnAccounting.computeAndDebit` inside the transaction ending the owner. It is
metadata-neutral: C and S write their own typed telemetry. Retried settlement
does not double-charge the shared tree budget. Summary calls consume neither
model iterations nor the turn budget. Paid rows held only in memory at process
death are lost and cannot be debited; see [recovery](recovery.md).

[kb-summarizer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/compaction-summarizer-and-overflow.md
