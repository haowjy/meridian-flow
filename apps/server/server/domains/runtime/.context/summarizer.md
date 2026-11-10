# Summarizer

One `ConversationSummarizer` port serves both paid summaries: compaction C and
handoff seed S. The path rule is [branch or rolling once][kb-summarizer]; there is no
caller-selected path.

## Owner and source

The owner is the turn whose response rows and gateway correlation are produced; the
source is the thread and optional cutoff being summarized. Compaction owns C and uses
its thread; handoff owns S and uses the cutoff owner's thread. Both project through
`projectActiveHistoryWithBakes`, so the summary reads the same frozen history as the
runtime.

Branch requests preserve the source request's fields (output limit, tools, tool
choice, reasoning, cache key, cache retention) and add only the summary instruction, so the
cached prefix doesn't change. The warm branch's retained-scope rule exempts
`## Documents to keep open`, so documents shown only in the retained tail can be
listed; the rolling path sees only the cut, and the server's recent-document defaults
cover the tail there.

Before either path, one settled-authority revision query over the source projection
supplies changed document URIs.

## Paid rows and settlement

Every attempted call returns its response row, cache prediction and message count
even if a later segment fails or Stop aborts it. `settleSummaryResponses` writes
predictions, request sizes and debits through `TurnAccounting.computeAndDebit` inside
the transaction ending the owner. It is metadata-neutral: C and S write their own
typed telemetry. Retried settlement doesn't double-charge the shared tree budget.

[kb-summarizer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/compaction-memory.md#two-summary-paths
