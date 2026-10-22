# Collab — reversal contracts

Reversal uses the same forward-inverse primitive for card actions, model
Undo/Redo/Revert, and failed-response rollback. An inverse is an ordinary
immutable journal edit; it never rewrites a target row or marks it reversed.

## Commands and policy

`reverseThreadContext` is the whole-turn card command. Its authenticated POST
accepts only `{ scope: "turn", target: turnId, direction }`; authorization
precedes inverse planning. One action may cover several documents, but each
inverse edit transitions one target edit and carries restoration aliases.
Each text step lands where its original did, live or its draft: one turn may
reverse a document's live and draft text together, each on its own view, inside
the one ordered stream. A model Undo or Redo follows its text edit between live
and the chat's draft instead of using the chat's current write mode; the result
names the version it followed. It does not cross from one Work's draft into
another. The card admits only the (document, branch)
destinations the writer's grants cover (`InverseDestination`); a refused draft
beside an allowed live edit is left out, not the whole document. Model Revert
still writes only in the chat's current version.

Redo is preferred when the latest unconsumed Undo has a reapplicable part;
otherwise an invertible active part offers Undo. Effective action state is
indexed per immutable part. A partial writer Undo does not expose an older
entry or mark the whole action undone. A rolled-back action has no stack
impact, and repeated rollback does not append another inverse.

The model owns one strict stack per thread/document. `write undo` and `write
redo` accept a count; `write revert` creates a new edit at the current
(destination) view. All three use Yjs identity: a part edited since is skipped
and listed by its 1-based immutable part ordinal and reason, without quoting old
or current text. Undo and Redo refuse `cant_*_changed` only when none of a text-only
edit remains to reverse. The model uses ordinary `read` for the passage;
`read(format: "edits")` reads immutable parts through the host port. Model actions
cannot use a reconstruction endpoint, reversal table, or reserved client. A
multi-edit Undo is all-or-nothing on stack availability, and Redo restores the
last undone edit first; a count beyond what is available refuses with the
available count and changes nothing. User-actuated entries refuse model stack
commands, and a model Undo of a draft edit after the chat moved to a different
Work refuses `cant_undo_elsewhere`. A card Undo names and skips a part whose draft
was discarded (`expired`) or that a later writer edit depends on
(`cant_undo_dependent`), and inverts the rest.
A turn's edit targets include its create transition even when the document is empty. A create
that Undo removed stays addressable through that immutable target, so Redo can restore it. A draft-scoped
edit of a document deleted live stays one (D79): each draft-scoped target names
the Work its draft row's branch belongs to, and the card's lineage and Undo
authorize it at that Work's draft destination (`turnEditDestination`), where
`survivingDraft` admits it while the draft is active. Its lineage address is the
location it was deleted at. Live-scoped targets authorize live.

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
retries the bounded attempt. For a removed document, an active draft of it is planned on like any draft; the removal record decides only when no active draft exists.

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

## Tree entries (creates, moves and deletes)

A model's `create`, `copy`, `move` or `delete` is represented by a `document_edits` row with a
`tree_change` and no parts
(`domain/tree-inverse.ts`, PR 3). It keys as `editId:tree` in the same action index and takes
its `seq` from the parts' id sequence, so one chronology orders text and tree across turns and
writers. Its handle is on the same per-document, per-chat counter. It records the exact state
transition in its destination (live placement or removal; a branch row's facts), and every
inverse row records the transition it made (`targets` names the entry).

Tree entries are judged by state, never by row presence: an entry stands while its
destination still holds the `after` of its latest transition (the entry itself, a row naming
it, or a row reversing such a row: an undo of a revert reapplies the entry, a rollback of an
undo leaves it as the undo found it; latest, since a redone delete writes a new removal); an
undo restores the `before`. A later own entry that was undone does not block, so A→B, B→C,
undo, undo returns to A. Applied or discarded comes only from a later settlement row naming
the entry; an Apply names entries undone before it as discarded, so their redo refuses
rather than proposing them again. History is read with folders a live folder absorbed since
resolved to it (`withCurrentFolders`), and commit resolves the absorber again before writing
live placement or branch facts. A reversal reports each destination it landed in and, when its
committed path differs from the recorded one, that path too: live, or the branch whose text
draft or tree facts took it. The history writer (`recordDocumentEdit`) is the one place a transition's states
are checked against its destination and op; readers trust the rows.

Every inverse (model undo, redo and revert, the card, a reply's rollback) is one ordered
stream of steps (`domain/inverse-stream.ts`): each selected original edit is one step, text or
tree, with its action and its place on the shared id axis allocated in that one loop, planned
on a simulation the steps before it advanced (simulated rows, destination states, one clock).
So a restore planned earlier lets later live text be reversed, a model count-N Undo records N
separately redoable actions, and a step that reverses an undo puts its edit back on the stack.
A removal an earlier step makes is `madeBy` that step until it runs; a restore planned after it
carries the removal that step actually made, while an unrelated removal still refuses it. The
commit runs the steps in planned order (the card and rollback merge documents newest first,
redo oldest first), each tree step in its own savepoint: a fault (`ancestor_taken`,
`folder_missing`, `superseded`) is a reported skip for the card and rollback, and live text of a
document a skipped restore left removed is skipped with the rest of that document's text. A
model inverse is all or nothing (`TreeInverseRefused`). A draft's text still commits as one
checkpoint rewrite, at its plan's first text step. Every tree inverse commits under
`acquireTreeScope` over the attempt's documents and the placements it returns to, then
re-reads the captured tree states (a mismatch is an attempt miss). Live moves back go through
`moveToPlacement`, deletes back through `restoreDocument` naming the removal, redone deletes
through `DocumentRemoval.remove`. A tree-only inverse has no text cuts, so the engine echoes no
blocks. Turn targets include every document a turn created, moved or deleted, deleted or not;
the card authorizes them from those targets, and a deleted one at its restore destination
(file-policy's `restore` target). The turn lineage gives each document the turn created, moved
or deleted its net tree line per destination (live, or the Work whose branch a drafted entry
names) (`TurnTreeLine`: created, deleted, or moved from its first `shownAt` to its last move's
`landedAt`), leaving out entries a rollback reversed. A removed one keeps its receipt row at its
last or recorded create address, read through the same `restore` target. A drafted tree entry's
inverse writes back the branch row's facts its entry recorded (an undo its `before`, a redo its
`after`; `writeBackBranchFacts`) while the row still holds the state the plan started from, its
branch is active, a moved folder still stands and the branch's view has room; the attempt also
locks that branch's Work and where the branch has the document. The routed branch is separate
from a content `draftId`: a move-only document has no text draft, including a Scratch document
whose content stays live, but Undo and Redo still write its branch facts. A document the branch deleted is
authorized where its row is (file facts' branch-deleted fallback).

A create transition precedes its initial text edit in the same per-document stream. Model Undo
groups those adjacent entries as one edit: it removes the initial text, then the placement;
Redo restores the placement, then the text. A live Undo removes the document with the ordinary
removal record, and Redo restores its identity through `restoreDocument`, taking the next free
name when necessary. A drafted Undo ends the created draft, removes the branch's `created` fact
and tombstones the unused identity. Redo restores that identity and writes the original content
into a fresh draft. Empty creates have only the tree entry and follow the same path. An undone
draft create no longer contributes a pending review item.

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
those outcomes and refresh the turn query. A reversal that reversed nothing because a document
blocks an ancestor folder, the folder is missing, or the document moved or was deleted again
answers `ancestor_taken`, `folder_missing` or `superseded` (per document too), never `expired` or
`cant_undo_dependent`. Every skipped part carries a typed `cause` (`TurnInverseSkipCause`) and the
app words it; a tree skip names the path its entry was shown at.

Failed-response rollback selects immutable parts by `editScopeId`, records
accepted parts as terminal rollback edits, and keeps only uninvertible pending
targets in `rollback_pending`. A failed checkpoint or report cannot reject a
durable save.

A released closed draft has no bytes from which to describe a receipt's prose.
Live has unrelated Yjs identity, so skipped inverse parts can retain their cause
without before/after snippets; never merge live to manufacture them.
