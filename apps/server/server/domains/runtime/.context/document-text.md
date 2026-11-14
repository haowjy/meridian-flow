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

Revision evidence is distinct from shown-link evidence and is not derived from it.

## Shown links

Tool results that show document links carry host-only shown-link facts, stripped
from the model-facing result. The document side (collab's `ModelEvidence`) owns the
rows: an edit's are recorded in the edit's own command transaction, a read's are handed
over after its block is stored (`DocumentEvidence.resultStored`), and a writer turn's
reference blocks' are handed over in the transaction that persists those blocks.

Rows are per showing key per turn. Fork readers select their own and source rows
through the cutoff, then deduplicate by the latest eligible sequence; nothing is
copied at fork time. Handoffs and spawned children inherit no rows. A thread's rows go
when the thread is deleted (`forgetThreads`).

## Observation frontiers

Room `tree` of the same table is not text: it holds the names the model was shown per chat
(`TREE_NAMES_ROOM`, `shownNames` on the tool context), which tree commands resolve paths
through (`domains/context/tree/names-shown.ts`). Its key is the block and the room, so a
result holds a row for the document it showed and one for the names.

[The Model's View][kb-model-view] is the current implementation. A handler returns
host-only evidence beside the result and the executor strips it from serialized output.
Collab keeps the rows, keyed by the result block's id and the room with no foreign key to the
block, so a row a crash left behind is never read: every lookup names the block ids it asks
about (`loop/frontier-recording.ts` names the blocks the request carries).

- **An edit** records its frontier, the names it showed and its shown links in its command
  transaction, under the result block's id (`modelEditIds(key).blockId`); a refused edit
  records none, and what its refusal showed is handed over like a read's. A crash after the
  commit loses nothing.
- **A read** returns its evidence beside its result; once the block is stored,
  `recordStoredResult` calls `resultStored`. Only a returned value is handed on, so a handler
  that outlived its timeout attaches nothing. A failed hand-over logs
  `observation_frontier.record_failed` and the block keeps no frontier; a crash between the
  two loses that read's evidence, and the model's next write plans on its previous frontier
  (Yjs still merges; the report of concurrent changes can name too much).
- Inverse echoes record a frontier without the concurrent-change lookup.

## Tool policy and elision

`ToolRegistration.documentText` owns each tool's stale/history treatment and
`historySummary` owns the text after a history call line. Missing registration or
pairing fails closed.

A policy's `elide` returns the replacement `text`, which becomes the block's whole
`content` (one text part), so a media part in a stale result goes with its text; the
stub describes the document. A completed compaction owns frozen `metadata.elisions`, applied by the active
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
