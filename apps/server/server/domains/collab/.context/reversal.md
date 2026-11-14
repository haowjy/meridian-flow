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

After selection, one admission call authorizes every content destination. Commit runs under those exact grants and confirms them after
locking their combined Work set. The incoming content grant carries the caller
identity only; it never chooses the inverse branch. Undo and Redo land in the
Work that owns the selected edit, including after the chat is rebound. A user
card uses the same admission boundary.

Redo is preferred when the latest unconsumed Undo has a reapplicable part;
otherwise an invertible active part offers Undo. The card counts only a person's Undo
(its own, `actor: "human"`): the model's undo in the reply is part of what the reply did and
gives the card no Redo, the same rule as for tree receipts below. Effective action state is
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
the chat's query draft never decides availability for live text. A surviving draft
still ignores live removal and accepts its own inverse.

Applied text is not a refusal. Model Undo and the card write its inverse as a forward
`revert` in the active origin draft, leaving live untouched and making a pending change against
the review base. Redo of an Undo whose inverse was applied reapplies the original parts through
that same captured origin.

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

## Tree changes

A tree change (create, move, rename, delete, restore, folders included) is its own command
with its records in the project's tree list, and a failed reply leaves what its tree calls did.
A chat card's Undo or Redo of a turn takes the reply's tree receipts back too, in the same
`reverse_turn` command as the text (`adapters/drizzle-turn-tree-inverse.ts`, after the text
steps, newest receipt first; a Redo takes the receipts the card's Undo reversed, oldest first: a
receipt the model's own `undo` reversed in the reply is part of what the reply did, and gives the
card no Redo). The receipts one list holds go back in one update of that list, so a browser showing
it redraws once for the whole Undo, not once a receipt. It
chooses from the same receipts and `reverses` links the model's `undo` does (`turnSteps`), takes
each back by `undoChange` in the list that holds the node, and records the reversal as a
receipt, so the two histories are one. A receipt something changed since answers `superseded`
(a skip, as `cant_undo_changed` is the model's answer); a move between a project and `user://`
goes back by the model's own move the other way (`moveBackAcrossLists`, the context port's
`moveAcrossLists`, which the reverse route builds from the thread's context and hands down as
`moveBackAcrossLists`; locking both lists), and is `superseded` once a later change moved or
renamed the node. A reply that only changed the tree has a card: its documents are listed from the
turn's tree receipts too (`readTurnTreeTargets`), its folders as well (`readTurnFolderTargets`:
a folder has no document, so the item carries the node id with `folder: true` and no door), and
the receipt chip counts the tree steps. Its lists' keys are taken before the documents' (in
`acquireMutationScope`), and its edit grants are the documents' own, a restore its own grant.
A turn's text on a document the same turn deleted is not a card target while the document is in
Trash: the card's Undo restores the document, and a second Undo takes the text. The model's tree call
keeps a receipt (`tree_edit_receipts`: the record ids, the Work's branch) and one
`tree_edit_receipt_nodes` row for every node it changed, each with a write ordinal reserved on
that node's counter (`agent_edit_wid_counters`), the sequence the node's text edits take. The
`e<N>` the model is given is the ordinal on the receipt's subject.

A node has one history per chat: its tree receipts and its text edits, ordered by that ordinal,
with what was undone left out (`TreeHistory.historyOf`: the receipts that took a step and were
not reversed, the receipts an Undo made and a Redo has not, and the ordinals the text engine's
own stack gives, `modelStack`). Model `undo` takes the newest `count` of them across both kinds,
`redo` the tree receipts undone after the text engine's newest undo, and `revert` the receipt
the handle names. Tree records go back through the package's `undoChange`, which finds the live
copy of an applied or restored change by `carries`, and takes back only what the receipt did:
what others put in a folder it made stands and keeps it standing. The records an Undo makes name
what they take back (`undoes`), a Redo's included. A move between a project and `user://` is two
lists' records; its receipt is marked `across_lists` and is taken back by the same move the other
way. A model `undo` that takes tree and text steps together is one command (the tree receipts
first, then the text engine's), so a refusal of the text half takes the tree half back with it.
The receipts carry the command's id (`tree_edit_receipts.command_id`), as the text receipts do,
and Undo counts by it: the steps of one command (a create with content is a node and its text)
are one step, taken and redone together; `revert` names a handle and takes that receipt only.

Every inverse (model undo, redo and revert, and the card) is one ordered
stream of text steps (`domain/inverse-stream.ts`): each selected original edit is one step,
with its action and its place on the history axis, planned against a simulation the steps
before it advanced (simulated rows, one clock). A model count-N Undo records N separately
redoable actions, and a step that reverses an undo puts its edit back on the stack. The commit
runs the steps in planned order (the card merges documents newest first, redo
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
