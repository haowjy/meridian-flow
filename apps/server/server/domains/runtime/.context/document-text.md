# Document text in history

Revision, shown-link and observation-frontier evidence for document copies in
history. Compaction replaces stale copies selectively; `thread_history` stubs every
copy and preserves mutation inputs, so the transcript itself stays unchanged.
Compaction replaces text only where the retained prefix already breaks at position
0, and doesn't rewrite later arrivals.

## Revision evidence

Document reads, grep hits, settled writes and reference reads persist
`DocumentRevisionEvidence`; the model sees only result text. A null revision means
unverifiable and is never resolved against current content. Failed lookups and edits
fail closed.

A pre-compaction held tool result (`isNotesStepHeldResult`) executed nothing.
Exclude it from document pairing and edit records, and retain its not-run output
verbatim in compaction and history, rather than treating missing evidence as a stale
successful write.

Staged mutation results start with null. The response-settlement receipt supplies
the revision captured at apply, and `persistCommittedWriteResult` copies it without
a second read: a reread would misattribute an intervening writer edit. Revision
evidence is distinct from shown-link evidence and is not derived from it.

## Shown links

Tool results that show document links record host-only shown-link facts, stripped
from the model-facing result. Handlers produce candidates and the executor records
them only with an accepted result, in the transaction of the tool result or
reference blocks. Settled receipts and concurrent response fits use the response
save transaction. A response rollback still keeps evidence for an echo the model
already saw.

Rows are per showing key per turn. Fork readers select their own and source rows
through the cutoff, then deduplicate by the latest eligible sequence; nothing is
copied at fork time. Handoffs and spawned children inherit no rows.

## Observation frontiers

Room `tree` of the same table is not text: it holds the names the model was shown per chat
(`TREE_NAMES_ROOM`, `shownNames` on the tool context), which tree commands resolve paths
through (`domains/context/tree/names-shown.ts`).

[The Model's View][kb-model-view] is the current implementation. Here, a handler
returns host-only evidence beside the result, and the executor strips it from
serialized output and records it with the source block; `source_block_id` permits at
most one row per block and room. Inverse echoes record a frontier without the concurrent-change
lookup. A failed insert logs `observation_frontier.record_failed` and the result
still commits.

## Tool policy and elision

`ToolRegistration.documentText` owns each tool's stale/history treatment and
`historySummary` owns the text after a history call line. Missing registration or
pairing fails closed.

A completed compaction owns frozen `metadata.elisions`, applied by the active
projector only to C's retained tail and pinned requests; failed, pending and
superseded owners don't apply them. Forks inherit elisions only when their cutoff
includes C.

A document the compaction re-shows in full after its summary
([important files](compaction.md#important-files)) elides every tail copy of it as
`reshown`, stale or not, with a stub pointing at the text after the summary; a block
that also holds some other stale document keeps its stale stub.

Successor preparation queries current revisions from raw retained blocks once per
attempt. Stale text in pinned unanswered messages is replaced while writer words and
mentions stay verbatim. `DocumentRevisions.current` reads settled authority only: a
response-staged overlay visible to it is a contract failure, not a lookup fallback.

[kb-model-view]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/model-view.md
