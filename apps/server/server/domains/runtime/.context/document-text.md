# Document text in history

This context defines revision, shown-link and observation-frontier evidence
for document copies in history. Compaction replaces stale copies selectively; `thread_history` stubs
every copy and preserves mutation inputs, so the transcript itself stays
unchanged. Compaction applies replacement only where the retained prefix
already breaks at position 0; it does not rewrite later arrivals.

## Revision evidence

Document reads, grep hits, settled writes, and reference reads persist
`DocumentRevisionEvidence`; the model sees only result text. URI is canonical at
observation time. A null revision means unverifiable and is never resolved
against current content. Empty evidence is explicit; failed lookups and edits
fail closed.

A pre-compaction held tool result (`isNotesStepHeldResult`) executed nothing.
Exclude it from document pairing and edit records; retain its not-run output
verbatim in compaction and history instead of treating missing evidence as a
stale successful write.

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

An observation frontier records the document cut a block showed the model: `{ room, snapshot, position }` in `observation_frontiers`. The row belongs to a `tool_result` or a user turn's materialized reference block, and `source_block_id` permits at most one per block. The room is `draft:<workDraftId>` or `live:<documentId>:<authorityGeneration>`; `position` is the room journal's high-water mark at the same cut.

Every write plans on the request's frontier plus the reply's own accepted writes, then merges into the current Yjs room. A first Work-draft write projects its live observation onto the draft's revision-0 seed. Projection is a planning base, never a refusal. Results group concurrent changes by evidenced author through one lookup bounded after the observed position and through the rendered position. Inverse echoes record a frontier without that lookup. Unknown evidence renders as `unattributed`, not as a user.

- **What records.** Reads, immediate write echoes, inverse echoes, settled save receipts, and reference reads record. A staged echo records nothing because its save replaces it before the next request. Refusals, `format: "edits"` reads, and copy source reads record none.
- **Recording.** A handler returns host-only evidence beside the result. The executor strips it from serialized output, then records it with the source block. A failed insert is logged as `observation_frontier.record_failed`; the result still commits without a frontier.
- **Lookup.** The latest `recorded_seq` among the conversation's eligible blocks wins. Forks find inherited source-block rows without copying them. Handoffs and spawned children inherit none.

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

Reference snapshots can carry host-only `read.input`: the actual ordinary read
arguments, separate from canonical identity. The ordinary schema validates it
before the shared tracked read executes it. Persisted input is display-only JSON;
replay never executes it. Both entry points share scope, grant, version and
frontier logic; submitted references cannot carry read metadata.

A document the compaction re-shows in full after its summary
([important files](compaction.md#important-files)) elides every tail copy of it
as `reshown`, stale or not, with a stub pointing at the text after the summary;
a block that also holds some other stale document keeps the `stale` stub.
Partial re-shows never authorize duplicate elision. Later writes to outside blocks
still merge with the current room and report changes since the stored cut.

Successor preparation queries current revisions from raw retained blocks once
per attempt. Stale text in pinned unanswered messages is replaced while writer
words and mentions remain verbatim. A response-staged overlay must not be
visible to `DocumentRevisions.current`; that is an invariant failure, not a
lookup fallback.

[kb-elision]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/request-prefix/stale-document-elision.md
