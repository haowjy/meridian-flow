# Collab — reversal contracts

Reversal uses the same forward-inverse primitive for card actions, model
Undo/Redo/Revert, and failed-response rollback. An inverse is an ordinary
immutable journal edit; it never rewrites a target row or marks it reversed.

## Commands and policy

`reverseThreadContext` is the whole-turn card command. Its authenticated POST
accepts only `{ scope: "turn", target: turnId, direction }`; authorization
precedes inverse planning. One action may cover several documents, but each
inverse edit transitions one target edit and carries restoration aliases.
Dry-run and execution choose one destination view per document.

Redo is preferred when the latest unconsumed Undo has a reapplicable part;
otherwise an invertible active part offers Undo. Effective action state is
indexed per immutable part. A partial writer Undo does not expose an older
entry or mark the whole action undone. A rolled-back action has no stack
impact, and repeated rollback does not append another inverse.

The model owns one strict stack per thread/document. `write undo` and `write
redo` accept a count; `write revert` creates a new edit at the current
(destination) view, by Yjs identity only: a part edited since is skipped and
listed by its 1-based immutable part ordinal and reason, without quoting old or
current text. The model uses ordinary `read` for the passage; `read(format: "edits")` reads immutable parts through the
host port. Model actions cannot use a reconstruction endpoint, reversal table,
or reserved client. A multi-edit Undo is all-or-nothing and Redo restores the
last undone edit first; a count beyond what is available refuses with the
available count and changes nothing. User-actuated entries refuse model stack
commands, and a model Undo of a draft edit after the chat's Work moved refuses
`cant_undo_elsewhere`. A card Undo names and skips a part whose draft was
discarded (`expired`) or that a later writer edit depends on
(`cant_undo_dependent`), and inverts the rest.
A turn's edit targets exclude tombstoned documents (`livingDocumentSql`), so
a discarded draft-created document or one the writer deleted is never an
inverse target and drops out of Undo as it does from lineage. Final address
liveness stays with the lineage reader.

Card authorization and change-viewer discovery share immutable edit and
origin targets with inverse admission; mutation and draft transport
journals are never authorization lineage. Card inverse rows are writer rows
with no turn, and restoration correspondence comes from certified aliases on
immutable parts, never equal text. Save and rollback take a
`ModelResponseIdentity`, not a bare string that could mean provider response or
helper scope: `response_id` keeps provider authorship and `edit_scope_id`
selects the rotated scope.

Part disposition comes from `createDraftDispositionReader`: Apply-record evidence
wins; otherwise classification membership in an active draft is pending and the
rest discarded. Inverse capture reads each origin draft once, including closed
drafts, and matches receipts by edit id and ordinal. Active draft write admission
is separate; a revision mismatch between the evidence and planning captures
retries the bounded attempt. A removed document's record takes precedence.

Model Undo/Redo keep `cant_*_applied`. Review disposition is not inverse
eligibility: an effective Undo that restores the review base has no shown change
and can read discarded. In an active draft the kernel decides Undo/Redo, Revert
and failed-scope rollback eligibility; discarded disposition chooses the copy
only when the kernel skips a part. Closed origin drafts refuse without planning.
Effective action consumption follows immutable receipts, regardless of whether
those receipts currently contribute to review. Applied draft parts revert only
in their active origin draft, leaving live untouched and making a pending change against base.
Closed drafts are never writable. Runtime context reports a card action by turn
and document, not model handle. There are no inverse holds or blocking flags.

## Effects and failures

`hasEffect` compares the committed draft's `review_base` and `prosemirror` blocks.
Pending lists and counts include active drafts with `hasEffect`, plus created
nodes (including empty creates). Membership never depends on journal count,
generation, or inverse state. Receipt/chat membership comes from the shared
captured classification, not replayed journal ownership. The projection job is
dirtied after inverse commit; the inverse writes neither effect nor baseline.
Pull snapshot, effect, and projection updates commit in their own root
transaction. Root pulls must not be awaited while holding Work locks.

An inverse is an attempt. It captures its documents in one read snapshot with
no lock or lease (live state, live heads, committed drafts alone) and plans
off every lock. Its commit scope takes the live mutexes, then one savepoint
whose first locks are the Work rows (the captured drafts' Works and the bound
grants' Works in id order, the grants confirmed: a seam boundary), then its
documents' mutation locks in id order; the inverse takes no lock of its own,
since the captured fences order two inverses of one edit. Inside it, each
live destination's head must equal the captured head, and each draft
destination is an exact checkpoint rewrite at its captured revision. A miss
unwinds the whole attempt and recaptures. After four misses one more capture is
planned without writing: a plan that refuses every part answers with its own
reasons, and one that still applies is a conflict, `ReversalConflictError` for
the card and `internal_error` ("the document changed while reversing; try again")
for model Undo, Redo and Revert, never an invented refusal. Delivery runs
after the commit, outside the scope.

A card outcome reports committed destination per document. Draft Undo says that
Apply is needed to change the manuscript. The reverse endpoint may return
semantic unavailable outcomes such as `nothing_to_undo`, `nothing_to_redo`,
`cant_undo_dependent`, `expired`, or `partial` with HTTP 200; callers retain
those outcomes and refresh the turn query.

Failed-response rollback selects immutable parts by `editScopeId`, records
accepted parts as terminal rollback edits, and keeps only uninvertible pending
targets in `rollback_pending`. A failed checkpoint or report cannot reject a
durable save.

A released closed draft has no bytes from which to describe a receipt's prose.
Live has unrelated Yjs identity, so skipped inverse parts can retain their reason
without before/after snippets; never merge live to manufacture them.
