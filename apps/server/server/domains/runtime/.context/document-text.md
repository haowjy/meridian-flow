# Document text in history

This context defines revision, shown-link and observation-frontier evidence
for document copies in history. Compaction replaces stale copies selectively; `thread_history` stubs
every copy and preserves mutation inputs, so the transcript itself stays
unchanged. Compaction applies replacement only where the retained prefix
already breaks at position 0; it does not rewrite later arrivals.

## Revision evidence

Document reads, search hits, settled writes, and reference reads persist
`DocumentRevisionEvidence`; the model sees only result text. URI is canonical at
observation time. A null revision means unverifiable and is never resolved
against current content. Empty evidence is explicit; failed lookups and edits
fail closed.

Staged mutation results start with null. The response-settlement receipt supplies
the revision captured at apply, and `persistCommittedWriteResult` copies it
without a second read; a reread would misattribute an intervening writer edit.
Compaction compares stored evidence with current revisions through the
`DocumentRevisions` port. Revision evidence is distinct from shown-link
evidence and must not be derived from it.

## Shown links

Tool results that show document links record host-only shown-link facts keyed by
thread, document/ref, address, holder URI, view, and turn. The model-facing
result is stripped of `shown`/`showing`; handlers produce candidates, and the
executor records them only with an accepted result, inside the same transaction
as the tool result or reference blocks. Aborted, timed-out, or thrown handlers
record nothing. Settled receipts and concurrent response fits use the response
save transaction.

Rows are per showing key per turn. Fork readers select their own and source
rows through the cutoff, then deduplicate by the latest eligible sequence;
nothing is copied at fork time. Handoffs and spawned children inherit no rows.
The in-memory repository transaction rolls evidence back with a failed result;
a response rollback still keeps evidence for an echo the model already saw.

## Observation frontiers

An observation frontier records what document state a block showed the model:
`{ room, snapshot, unshown }` in `observation_frontiers` (the room in
`room_key`), on the source block: a `tool_result`, or a writer turn's reference
block whose materialized read the model is sent. A block records at most one
(`source_block_id` is the primary key).
The room is `draft:<workDraftId>` (the Work draft the call read, never a peer)
or `live:<documentId>:<authorityGeneration>`; collab names it from what the
call read. `snapshot` is `Y.encodeSnapshotV2` of the doc the result was
rendered from; `unshown` lists blocks changed since the model's previous
frontier and not shown in full (`@meridian/agent-edit/integration` computes
both). Every write plans on the `planning` frontier of its room plus the
reply's own writes ([decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/concurrent-safety/merge/ai-writes-plan-on-what-the-model-was-shown.md));
concurrent-edit reporting still also runs on the journal watermarks until
the one listing replaces them (M2 W2).

- **What records.** Only results the model receives: reads, immediate write
  echoes, undo, redo and revert echoes, settled save receipts, and reference
  reads. A staged write's echo records nothing: the step's save replaces it
  before the next request is built. Refusals, `format: "edits"` reads and copy
  source reads record none. A result reported with `awarenessDegraded` records
  a frontier that counts no block as shown in full: its snapshot advances and
  every changed block is unshown.
- **Recording.** A handler returns its host-only `evidence` (`ResultEvidence`:
  shown links and the frontier) beside the result; the executor strips it from
  everything serialized, and dispatch records both in
  `persistAndAppendEvents`'s `afterEvents`, once the block row exists.
  Reference reads carry `ReferenceEvidence` the same way to the commit that
  persists their blocks. Deleting the block's old row is part of the block write
  and fails it; the insert runs in a savepoint, so a failed insert is logged
  (`observation_frontier.record_failed`) and the result commits with no
  frontier, never the stale one.
- **Saves.** The save records on each committed document's last settled
  result a frontier at the post-commit cut, chained like any result from the
  `recording` lookup, crediting what the settled receipts show in full (nothing
  when they are degraded or textless). The latest row may be a sibling read's
  from the same step: its snapshot holds the step's staged structs, so it
  validates only if they landed, and it credits only what that read showed.
  Recovery's journal replay leaves the cut unknown and records none; a failed
  save, a refused write and a typed rejection record none. Replacing a result
  replaces its row. Concurrent-run backfill keeps the settled row and is not
  credited.
- **Selection.** The model's frontier for a room is the row with the greatest
  `recorded_seq` among a block set (rooms only grow, so recording order is cut
  order). `frontierLookup` (`loop/frontier-recording.ts`) builds one lookup per
  block set. Dispatch puts two on `ToolHandlerContext.frontiers`: `recording`
  reads the run's current blocks, so a sibling call's result counts as seen,
  and `planning` reads the blocks the authoring request was built from (calls
  in one response share the view from before it; every write plans on it). The block set is the effective conversation (fork
  lineage through the cutoff, forgotten turns removed), not the compaction
  projection: credit survives a summarized or elided result. A failed lookup is
  logged and answers null, the empty frontier; it runs in a savepoint inside a
  transaction, so the caller's stays usable. Its `ORDER BY recorded_seq DESC
  NULLS LAST` matches the `(room_key, recorded_seq DESC NULLS LAST)` index, so
  the scan walks the room newest first and stops at the first row among the
  blocks.
- **Lifecycle.** Rows cascade with their block. A fork renders inherited block
  ids and finds their rows with nothing copied; a retry has new blocks.

## Tool policy and elision

`ToolRegistration.documentText` owns each tool's stale/history treatment and
`historySummary` owns the text after a history call line. Missing registration
or pairing fails closed. The treatment preserves compaction stub bytes or
history mutation inputs as appropriate.

A completed compaction owns frozen `metadata.elisions` (block, treatment, URI,
and replacement). The active projector applies them only to C's retained tail
and pinned requests; failed, pending, and superseded owners do not apply them.
Forks inherit elisions only when their cutoff includes C. Never write elisions
onto source block rows or derive stubs at render time, or a later source
compaction/deploy would rewrite a fork's frozen prefix.

Successor preparation queries current revisions from raw retained blocks once
per attempt. Stale text in pinned unanswered messages is replaced while writer
words and mentions remain verbatim. A response-staged overlay must not be
visible to `DocumentRevisions.current`; that is an invariant failure, not a
lookup fallback.

[kb-elision]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/request-prefix/stale-document-elision.md
