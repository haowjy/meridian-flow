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

## Tool-owned policy

`ToolRegistration.documentText` (`tools/document-text.ts`) owns each tool's
classification and replacement copy; `historyPreview`
(`tools/history-previews.ts`) owns its compact navigation marker. `read`,
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
