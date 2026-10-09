# Document text in history

A document's current text lives in the document. Copies of it in a thread's
history (read results, search excerpts, reference reads, write echoes) go
stale when the writer edits, so every copy records which revision it saw, and
two readers replace copies by different rules:

- **Compaction** (`stale` treatment) replaces only copies whose document has
  changed since they were observed, and only where the prefix already breaks
  at position 0. The rationale is the KB's
  [Compaction Elides Only Stale Document Text][kb-elision].
- **`thread_history`** (`history` treatment) stubs every copy regardless of
  revision and passes mutation inputs through as dated edit records
  ([history tools](history-tools.md)).

## Revision metadata

Document reads, search hits, and settled writes persist
`tool_result.content.metadata.documentRevisions` entries. Writer-reference reads
persist `read.revision` beside `read.result`. The model projection consumes only
the result, never these tokens. Entries use the shared `DocumentRevisionEvidence` contract:
URI is canonical at observation time. Null revision means unverifiable
(including binary references, failed writes, and unverified recovery).

Staged mutation results start with null. The response-settlement receipt supplies
the token captured at apply; `persistCommittedWriteResult` copies it without a
second document read. Re-reading here would misattribute a writer's intervening
edit to the agent write. Compaction compares these tokens with current ones from
the context domain's `DocumentRevisions` port (below).

Results without edit records persist an explicit empty revision list; quoted
edits use null revisions. An explicit empty `documentRevisions` means no
document text; absent evidence, null tokens, and failed lookups fail closed.
Known-null evidence is never resolved against current documents, including
failed edits with only a historical path.

## Shown links

Each tool result that shows the model a document's links also records them as
shown-link evidence ([`ports/shown-links.ts`](../ports/shown-links.ts), table
`thread_shown_links`). A row holds the link's ref, the absolute address shown,
the holder URI, the view (`live` or `draft:<workId>`) and the turn. When a
write rewrites links, ref assignment binds them to these rows. The model
never sees them: agent-edit's facts stay host-only on `WriteOutcome`, receipts,
concurrent runs and search hits, and handlers send only `result` or the
stripped hit.

Who records, all through the one store:

| Showing | Recorded in |
|---|---|
| successful read, narrowed or outline | `read` handler (`lib/model-tools/document-tools.ts`) |
| returned, authorized search passages | `search` handler (`listing-tools.ts`) |
| write echoes, staged or immediate, undo/redo, a partial failure's echo | `writeUnderGrant` |
| settled receipts | the response scope's commit (`loop/orchestrator.ts`), inside the save transaction |
| concurrent runs that fit the render budget | the response scope's backfill |
| `@` reference reads | `lib/model-tools/reference-reader.ts` |

Nothing else records evidence. Capture lives in the handlers, never in
`readDocument`, so a copy's private source read records nothing. Matches past
the passage cap, `thread_history` items, compaction summaries and handoff briefs
record nothing either. Never derive evidence from `documentRevisions` metadata:
that is revision evidence, and history copies carry it with null revisions.

The rows are independent of transcript blocks, so compaction and restart
lose none of them. A response that rolls back keeps its rows, since the model
saw the echo. Dedup keeps the latest showing per key, ordered by one global
`seq`. A fork reads its own rows plus its source's rows at turns up to its
cutoff position, recursively; nothing is copied at fork time. Handoffs and
spawned children inherit nothing, because they start from a brief.

Delivery: `writeUnderGrant` binds `WriteContext.shownLinks` to
`ShownLinkStore.forDocument(threadId, ·)`. The pool spreads the context
through, so the field survives. Utility, seed and import writes pass none, so
their links bind fresh.

## Tool-owned policy

`ToolRegistration.documentText` (`tools/document-text.ts`) owns each tool's
classification and replacement copy; `historySummary`
(`tools/history-summaries.ts`) owns what follows its history call line's `→`. `read`,
`write` and `search` register policies, each with a fixed kind; references use
`reference-context`. Error pairs are outside the policy. Tool pairing, reasoning, writer
words, and fresh text stay. Missing tool pairing or registration fails closed
on result text. The `stale` treatment preserves compaction's stub bytes; the
`history` treatment preserves mutation inputs and stubs copies.

## Elision at compaction

The writer transcript stays intact. A completed compaction owns frozen
`metadata.elisions` (block ID, treatment, affected URIs, replacement content).
The active projection ([compaction](compaction.md#one-projection-authority))
substitutes them only in C's retained tail and pinned requests, not later
arrivals. Failed, pending, and superseded owners do not apply.
Forks inherit this metadata only when their cutoff includes the owner. Never move elisions onto block rows: a fork reads its source's blocks in place,
so a source compaction after the cutoff would rewrite the fork's request. Do not derive stubs at render
time either: a copy change in a deploy would rewrite every compacted thread's
prefix. `compaction/elide.ts` plans the replacements and
`compaction-revisions.ts` queries current revisions.

Stale reference reads inside pinned unanswered messages are elided; the writer
words and mention stay verbatim. Pins retain identity and order, not stale
embedded document text.

Successor prepare independently queries current document revisions once per
attempt and plans from raw retained blocks, never from a previous owner's
replacements. A moved leaf re-queries, while a failed prepare writes no elisions.
An edit made after the successor commit reaches the model as stale text until
the next compaction; elision runs only where the prefix already breaks at
position 0.

The loop asserts no response scope is open: `DocumentRevisions.current` cannot
represent response-staged overlays. Query failures become unknown tokens; the
assertion is an invariant failure, not a lookup failure.

[kb-elision]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/request-prefix/stale-document-elision.md
