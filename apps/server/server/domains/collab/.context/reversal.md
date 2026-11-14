# Collab — reversal contracts

Reversal uses the same forward-inverse primitive for card actions, model
Undo/Redo/Revert. An inverse is an ordinary
immutable journal edit; it never rewrites a target row or marks it reversed.

## Commands and policy

`reverseThreadContext` is the whole-turn card command. Its authenticated POST
accepts only `{ scope: "turn", target: turnId, direction, commandId }`; the browser mints
`commandId` for each click and each Try again. It is a `reverse_turn` row in `document_commands`:
`DocumentCommands.run` claims the id and runs the whole reversal in one transaction, and stores
its outcome, the no-op and refusal answers included (`nothing_to_undo`, `expired`,
`permission_denied`). The turn's Work receipts (`reverseTurnCard`'s `alongside`,
`lib/work-receipt-reversal.ts`) are a second `reverse_turn` command once that one committed,
under an id derived from the click's, on the documents' outcome: their Work and thread locks
never wait under a document key. Its stored outcome is the click's answer. A resend under the id
answers the stored outcomes and changes nothing; a kill between the two runs the second on the
resend; another request under the id is `command_conflict` (409). The receipts the reversal
writes carry `document_edits.command_id`. A miss the server retries (a moved capture, a deadlock)
rolls back past the claim; exhausting the inverse's attempts is `ReversalConflictError` and
stores nothing. The capture's reads run on the command's own connection, as a model edit's do. Capture resolves each
immutable origin once: live, its active draft, or gone. One turn may reverse a
document's live and draft text together, each on that destination's captured
view, inside one ordered stream. Planning, history and result presentation use
that same resolved object; commit validates it before writing the planned view.

After selection, one admission call authorizes every content destination and
tree branch. Commit runs under those exact grants and confirms them after
locking their combined Work set. The incoming content grant carries the caller
identity only; it never chooses the inverse branch. Undo and Redo land in the
Work that owns the selected edit, including after the chat is rebound. A user
card uses the same admission boundary.

Redo is preferred when the latest unconsumed Undo has a reapplicable part;
otherwise an invertible active part offers Undo. Effective action state is
indexed per immutable part. A model count consumes original actions: once a
partial model Undo reverses any surviving part of an edit, the next count
continues to the preceding edit; Redo retains the exact parts that were
reversed.

The model owns one strict stack per thread/document. `write undo` and `write
redo` accept a count; `write revert` creates a new edit at the current
(destination) view. All three use Yjs identity: a part edited since is skipped
and listed by its 1-based immutable part ordinal and reason, without quoting old
or current text. Undo and Redo refuse `cant_*_changed` only when nothing of a text-only
edit remains to reverse. The model uses ordinary `read` for the passage;
`read(format: "edits")` reads immutable parts through the host port. Model actions
cannot use a reconstruction endpoint, reversal table, or reserved client. A
multi-edit Undo is all-or-nothing on stack availability, and Redo restores the
last undone edit first; a count beyond what is available refuses with the
available count and changes nothing. User-actuated entries refuse model stack commands. A card Undo pops the turn's
poppable stack prefix and writes forward reverts for its other text parts, including applied
parts. Both kinds share one action identity, so the card's Redo reverses exactly the parts its
Undo accepted. The card names and skips a part whose draft was discarded (`expired`) and inverts the rest.
Each agent is its own peer: Undo of its edit removes the items the edit inserted and restores
the items it deleted, item by item, and keeps everyone else's typing, so a later writer edit
never refuses it. An item that is already gone is skipped ("Stayed as you edited it"): text
the writer deleted, a deleted paragraph's words (Undo never re-creates an ancestor the
writer deleted), a heading level or other attribute the writer set after the edit. An
element the edit created that the writer typed in stays, holding only the writer's text.
A replacement is a deleted run with the part's insertion beside it. The deleted run stays
gone only when the insertion is gone and text written after the edit (the writer or a pull
replaced it; a clock at or past the part's `frontier`, read on the original of an
Undo- or Redo-restored copy) stands at its edge, so Undo doesn't
double it. When the writer only deleted the insertion, the original comes back. A pull or Apply
writes only the insertions inside a changed run that only gained characters (`retainShared` in
`packages/agent-edit/src/resolver/lower-block.ts`; any other change writes the run whole), so
Undo after a pull equals Undo of the same typing on the draft when the writer inserted inside
the AI's text. A writer's letter swap or deletion inside it lands as a replacement and stays.
Redo runs the same rule on the Undo's receipt. A part is `active` (Undo can act) while one
item can still be removed or restored, `undone` when only Redo can, else `changed`.
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
immutable parts, never equal text. A model write carries a
`ResponseAuthorship`: `response_id` keeps provider authorship. The command's id
(`document_edits.command_id`) joins the text and tree receipts of one call.

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
the chat's query draft never decides availability for live text or tree entries. A surviving draft
still ignores live removal and accepts its own inverse.

Applied text is not a refusal. Model Undo and the card write its inverse as a forward
`revert` in the active origin draft, leaving live untouched and making a pending change against
the review base. Redo of an Undo whose inverse was applied reapplies the original parts through
that same captured origin. Apply of an effective drafted delete records a fresh live delete
attributed to the drafting turn. The live entry names the exact draft entry it materialized, so
history shows one delete and reversal restores the named removal. Applied moves and renames
still refuse or skip until tree reverts are implemented.

Review disposition is not otherwise inverse eligibility: an effective Undo that restores the
review base has no shown change and can read discarded. In an active draft the kernel decides
Undo/Redo and Revert eligibility; a discarded or applied disposition
chooses the copy only when the kernel skips a part, ahead of the edited-since reading, so an
applied part never reads as the writer's edit. Effective action consumption follows immutable receipts,
regardless of whether those receipts currently contribute to review. Closed drafts are never
writable. History derives its offered command from the same captured origin-resolved plan as the
write command; an archived origin shows no action even when the chat's current destination is
writable. Runtime context reports a card action by turn
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
it, or a row reversing such a row: an undo of a revert reapplies the entry; latest, since a redone delete writes a new removal); an
undo restores the `before`. A later own entry that was undone does not block, so A→B, B→C,
undo, undo returns to A. Applied or discarded comes only from a later settlement row naming
the entry; an Apply names entries undone before it as discarded, so their redo refuses
rather than proposing them again. History is read with folders a live folder absorbed since
resolved to it (`withCurrentFolders`), and commit resolves the absorber again before writing
live placement or branch facts. A reversal reports each destination it landed in and, when its
committed path differs from the recorded one, that path too: live, or the branch whose text
draft or tree facts took it. The history writer (`recordDocumentEdit`) is the one place a transition's states
are checked against its destination and op; readers trust the rows.

Every inverse (model undo, redo and revert, and the card) is one ordered
stream of steps (`domain/inverse-stream.ts`): each selected original edit is one step, text or
tree, with its action and its place on the shared id axis allocated in that one loop, planned
on a simulation the steps before it advanced (simulated rows, destination states, one clock).
So a restore planned earlier lets later live text be reversed, a model count-N Undo records N
separately redoable actions, and a step that reverses an undo puts its edit back on the stack.
A removal an earlier step makes is `madeBy` that step until it runs; a restore planned after it
carries the removal that step actually made, while an unrelated removal still refuses it. The
commit runs the steps in planned order (the card merges documents newest first,
redo oldest first), each tree step in its own savepoint: a fault (`ancestor_taken`,
`folder_missing`, `superseded`) is a reported skip for the card, and live text of a
document a skipped restore left removed is skipped with the rest of that document's text. A
model inverse is all or nothing (`TreeInverseRefused`). A draft's text still commits as one
checkpoint rewrite, at its plan's first text step. Every tree inverse commits under
`acquireTreeScope` over the attempt's documents and the placements it returns to, then
re-reads the captured tree states (a mismatch is an attempt miss). Live moves back go through
`moveToPlacement`, deletes back through `restoreDocument` naming the removal, redone deletes
through `DocumentRemoval.remove`. A tree-only inverse has no text cuts, so the engine echoes no
blocks. Turn targets include every document a turn created, moved or deleted, deleted or not;
the card authorizes them from those targets, and a deleted one at its restore destination
(file-policy's `restore` target). The turn lineage gives each document the turn created, moved,
deleted or copied its net tree line per destination (live, or the Work whose branch a drafted
entry names) (`TurnTreeLine`: a create whose document records `metadata.copiedFrom` is a copy
from that source to where it ended up; otherwise deleted, or moved from its first `shownAt` to
its last move's `landedAt`), leaving out entries an undo reversed. A removed one keeps its
receipt row at its last or recorded create address, read through the same `restore` target. A
drafted tree entry's
inverse writes back the branch facts the plan selected (`writeBackBranchFacts`) while the row
still holds the state the plan started from, its
branch is active, a moved folder still stands and the branch's view has room; the attempt also
locks that branch's Work and where the branch has the document. The routed branch is separate
from a content `draftId`: a move-only document has no text draft, including a Scratch document
whose content stays live, but Undo and Redo still write its branch facts. A document the branch deleted is
authorized where its row is (file facts' branch-deleted fallback).

A create transition precedes its initial text edit in the same per-document stream. Model Undo
groups those adjacent entries only when both came from the same model tool call, in the same
turn, response and edit scope. A later write call in that response remains a separate edit. A
live Undo removes the initial text, then the placement; Redo restores the placement, then
reapplies only the text parts Undo reversed. A live Undo uses an ordinary reversible removal, so the identity,
Yjs history, later writer text and drafts remain available; Redo restores that retained state
through `restoreDocument`, taking the next free name when necessary. A drafted Undo writes the
branch's existing delete fact: `{ created: true, deleted: true }`. The document and its text are
hidden in that branch, but its draft remains active and its identity is not tombstoned. Redo
clears `deleted` on the row's current facts, so a rename or move made while the create was
undone survives, and keeps writing the same draft. Neither Undo nor Redo rewrites
the draft text. If another Work Applies the
shared creation first, that reveal settles this branch's undone creation so it cannot become a
pending delete of the now-live document, then the ordinary live pull rebases the now-visible
document into every active Work draft. Empty creates use the same branch-fact cycle.

## Effects and failures

`hasEffect` compares the committed draft's `review_base` and `prosemirror` blocks.
Pending lists and counts include active drafts with `hasEffect`, plus created
nodes (including empty creates). Membership never depends on journal count,
generation, or inverse state. Receipt/chat membership comes from the shared
captured classification, not replayed journal ownership. The projection job is
dirtied after inverse commit; the inverse writes neither effect nor baseline.
Pull snapshot, effect, and projection updates commit in their own root
transaction. Root pulls must not be awaited while holding Work locks.

An inverse is an attempt. It captures its documents with no lock or lease
(live state, committed drafts alone, history, dispositions) and plans off every
lock; those reads need not agree with each other. Its commit scope is one
savepoint whose first locks are the Work rows (the captured drafts' Works and
the bound grants' Works in id order, the grants confirmed: a seam boundary),
then its documents' mutation locks in id order, then its drafts' rows; the
inverse takes no lock of its own, since the captured fences order two inverses
of one edit. Under them it takes the capture again and compares the two
(`confirmCapture`): a write that landed since any read, or between two of them,
is a miss. Each draft destination is an exact checkpoint rewrite at its
captured revision. A miss
unwinds the whole attempt and recaptures. After four misses one more capture is
planned without writing: a plan that refuses every part answers with its own
reasons, and one that still applies is a conflict, `ReversalConflictError` for
the card and `internal_error` ("the document changed while reversing; try again")
for model Undo, Redo and Revert, never an invented refusal. Delivery runs
after the commit, outside the scope.

A card outcome reports committed destination per document. The reverse endpoint may return
semantic unavailable outcomes such as `nothing_to_undo`, `nothing_to_redo`,
`expired`, or `partial` with HTTP 200; callers retain
those outcomes and refresh the turn query. A reversal that reversed nothing because a document
blocks an ancestor folder, the folder is missing, or the document moved or was deleted again
answers `ancestor_taken`, `folder_missing` or `superseded` (per document too), never `expired`. Every skipped part carries a typed `cause` (`TurnInverseSkipCause`) and the
app words it; a tree skip names the path its entry was shown at.

A released closed draft has no bytes from which to describe a receipt's prose.
Live has unrelated Yjs identity, so skipped inverse parts can retain their cause
without before/after snippets; never merge live to manufacture them.
