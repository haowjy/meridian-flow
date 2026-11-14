# Collab — reversal contracts

Reversal uses the same forward-inverse primitive for card actions, model
Undo/Redo/Revert, and failed-response rollback. An inverse is an ordinary
immutable journal edit; it never rewrites a target row or marks it reversed.

## Commands and policy

`reverseThreadContext` is the whole-turn card command. Its authenticated POST
accepts only `{ scope: "turn", target: turnId, direction }`. Capture resolves each
immutable origin once: live, its active draft, or gone. One turn may reverse a
document's live and draft text together, each on that destination's captured
view, inside one ordered stream. Planning, history and result presentation use
that same resolved object; commit validates it before writing the planned view.

After selection, one admission call authorizes every content destination. Commit runs under those exact grants and confirms them after
locking their combined Work set. The incoming content grant carries the caller
identity only; it never chooses the inverse branch. Undo and Redo land in the
Work that owns the selected edit, including after the chat is rebound. A user
card uses the same admission boundary.

Redo is preferred when the latest unconsumed Undo has a reapplicable part;
otherwise an invertible active part offers Undo. Effective action state is
indexed per immutable part. A model count consumes original actions: once a
partial model Undo reverses any surviving part of an edit, the next count
continues to the preceding edit; Redo retains the exact parts that were
reversed. A rolled-back action has no stack impact, and repeated rollback does
not append another inverse.

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
available count and changes nothing. User-actuated entries refuse model stack commands. A card Undo pops the turn's
poppable stack prefix and writes forward reverts for its other text parts, including applied
parts. Both kinds share one action identity, so the card's Redo reverses exactly the parts its
Undo accepted. The card names and skips a part whose draft was discarded (`expired`) or that a
later writer edit depends on (`cant_undo_dependent`), and inverts the rest.
A later item depends on an edit when its parent or left neighbour is the edit's text; an item merely placed ahead of it (a concurrent draft's block that Apply put before it) does not.
A right origin that points at text the edit deleted does not count either: if an edit deletes a paragraph and the writer then places a paragraph in its place, Undo restores the deleted paragraph after the writer's, losing nothing. Counting those pointers would block "chat A replaces a paragraph, chat B places a block before it".
A turn's edit targets include its create transition even when the document is empty. A create
that Undo removed stays addressable through that immutable target, so Redo can restore it. A draft-scoped
edit of a document deleted live stays one: each draft-scoped target names
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

Part disposition is computed once for each resolved destination.
`createDraftDispositionReader` reads receipts from that draft. Apply evidence
wins; otherwise an active draft is pending and a gone draft is discarded. A
revision mismatch between evidence and planning recaptures the bounded attempt.
Closed origins are gone and never stand in for a destination.
A part the kernel cannot reach in an open draft (a sibling change in its paragraph was applied or
discarded since, or the writer typed over it) reads from its disposition first: applied is
"Applied to the manuscript", discarded is "Discarded", and only a pending part reads "Stayed as you
edited it". The planner decides these text-part causes once, for the per-edit omissions and the turn
record (`turnSkipCause` words it for the turn protocol); the service does not derive them. A one-by-one discard in an open draft
still reads edited: the draft keeps no mark that tells it from retyped text (#1361).
Live destinations carry the captured physical source owner's lifecycle and the document's removal;
the chat's query draft never decides availability for live text. A surviving draft
still ignores live removal and accepts its own inverse.

Applied text is not a refusal. Model Undo and the card write its inverse as a forward
`revert` in the active origin draft, leaving live untouched and making a pending change against
the review base. Redo of an Undo whose inverse was applied reapplies the original parts through
that same captured origin.

Review disposition is not otherwise inverse eligibility: an effective Undo that restores the
review base has no shown change and can read discarded. In an active draft the kernel decides
Undo/Redo, Revert and failed-scope rollback eligibility; a discarded or applied disposition
chooses the copy only when the kernel skips a part, ahead of the edited-since reading, so an
applied part never reads as the writer's edit. Effective action consumption follows immutable receipts,
regardless of whether those receipts currently contribute to review. Closed drafts are never
writable. History derives its offered command from the same captured origin-resolved plan as the
write command; an archived origin shows no action even when the chat's current destination is
writable. Runtime context reports a card action by turn
and document, not model handle. There are no inverse holds or blocking flags.

## Tree changes

Reversal of text and of tree changes are separate. A tree change (create, move, rename, delete,
restore, folders included) is its own command with its records in the project's tree list; no
turn reversal or failed-reply rollback reverses one, and a failed reply leaves what its tree
calls did. The model's tree call keeps a receipt (`tree_edit_receipts`: the record ids, its
`e<N>` handle on the node's per-chat counter, the Work's branch, and the `edit_scope_id` where
M10's command id goes). Model `undo`, `redo` and `revert` of a tree change take the receipt's
records back through the package's `undoChange`, which finds the live copy of an applied or
restored change by `carries`; the receipt of an undo is what `redo` takes back. A text edit
newer than the receipt hands the call to the text engine below.

Every inverse (model undo, redo and revert, the card, a reply's rollback) is one ordered
stream of text steps (`domain/inverse-stream.ts`): each selected original edit is one step,
with its action and its place on the history axis, planned against a simulation the steps
before it advanced (simulated rows, one clock). A model count-N Undo records N separately
redoable actions, and a step that reverses an undo puts its edit back on the stack. The commit
runs the steps in planned order (the card and rollback merge documents newest first, redo
oldest first). A draft's text commits as one checkpoint rewrite, at its plan's first step.
A document removed at capture plans no live text (`document_deleted` or `document_discarded`);
a draft that outlived the removal still takes its own inverse. Commit takes the attempt's
document mutation locks in id order.

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

A card outcome reports committed destination per document. The reverse endpoint may return
semantic unavailable outcomes such as `nothing_to_undo`, `nothing_to_redo`,
`cant_undo_dependent`, `expired`, or `partial` with HTTP 200; callers retain
those outcomes and refresh the turn query. Every skipped part carries a typed `cause`
(`TurnInverseSkipCause`) and the app words it.

Failed-response rollback selects immutable parts by `editScopeId`, records
accepted parts as terminal rollback edits, and keeps only uninvertible pending
targets in `rollback_pending`. A failed checkpoint or report cannot reject a
durable save.

A released closed draft has no bytes from which to describe a receipt's prose.
Live has unrelated Yjs identity, so skipped inverse parts can retain their cause
without before/after snippets; never merge live to manufacture them.
