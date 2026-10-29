# context/tree — views, identity, and hidden-node lifecycle

This page records how live and branch tree views expose identity and how hidden
nodes move through create, reveal, end-of-use, and repair. The one hidden
predicate and the lock order are the load-bearing rules.

## Views and ownership

`TreeView` is `LIVE_TREE` or `{ kind: "branch", branchId }`. Live views exclude
deleted and hidden rows. A branch's `branch_tree_changes` row has one logical
state, delete dominant: `deleting` (a move under it is masked intent, kept for
the delete's undo), `moving`, or `created`. A branch view's arms are disjoint
over it: live rows it neither moved nor deleted; the hidden documents and
folders it created or needs as ancestors, at their row-owned location; the
documents it moved, at its effective placement (`moved_folder_id`'s current
source, or `moved_root_source_id`, so a live rename or cross-source move of that
folder carries them, D80); and the deleted documents it has pending changes to
and no move or delete of (D79) with the deleted folders above them. A document
the branch deletes is in no arm; its identity is `deleted` there. Identity,
lineage and file facts read the effective placement, so a drafted manuscript→kb
move takes kb's grants.

`pendingIn` / `pendingDocuments` are the one reviewable-pending predicate: the
row's logical state against live's (deleting a living document; moving one
elsewhere, revealing a hidden creation at the branch's place, or restoring a
deleted one there; a created row while its document lives), or an active Work
draft with `has_effect` unless the branch is deleting the document. The
surviving arm, `treeState`'s `pending` (review membership), the Work counts and
the per-document branch hints all read it; write admission does not.
`branch-tree-changes.ts` writes drafted moves and deletes (`moveInBranch`,
`deleteInBranch`) and their inverses (`writeBackBranchFacts`) through the one
facts writer (`writeBranchTreeFacts`: a new `revision` from its sequence per
write, the first `base_version` kept). The row's `changed_thread_id` is the chat
whose turn the entry or its inverse belongs to, also when the writer's card or a
rollback runs the inverse: the chat's dock lists the pending item by it. Every folder a moved fact names is
held in `branch_tree_folders` per (branch, document) until settlement, even
after a later move or an undo leaves it: a held folder is in use for
hidden-folder liveness, so an undo or redo back into it finds it, and
`settleBranchEntries` (every terminal path: Apply, Discard, end of use, branch
close, purge) releases and prunes all of them, not only the row's current folder.
Every facts write also marks the document in `branch_tree_unsettled` until
settlement, so terminal cleanup finds a document whose row an undo removed (a
root-to-root rename has no folder to hold) and `readTreeScope` locks it.
Settlement names stack entries only (moves, deletes, reverts; never the undo,
redo or rollback rows): those in effect as the caller's applied or discarded,
those undone as discarded, those rolled back not at all.
Absorption rewrites the row's folder and repoints its holds; the tombstoned
hidden folder records `absorbed_into`, and the inverse service reads recorded
placements through `resolveAbsorbedFolders`, so an entry recorded against the
hidden folder still matches and writes back the live one. A create joins a hidden
candidate only while no branch using it moved it away. A live removal clears
each branch's `created` fact and keeps `moved` and `deleted` (D79, D80).

The live folder arm is its own `UNION ALL` branch so live
lookups keep their partial indexes; the hidden and deleted folders share one
non-live arm, so the branch's used-folder walk runs once per statement half, and
its predicate is `folders_nonlive_location`'s, so a path slot reaches that index. `deletedDocument` is the one definition of a deletion a draft
outlives (own or folder delete, reason `deleted`, no Work cascade); listing adds
the pending effect, admission (`survivingDraftDocuments`) an active draft or the branch's move of it.
The identity relations' diagnostic arms exclude a view's surviving rows, so each
identity appears once. Scratch content writes remain live, but a draft-mode Work reads its Scratch
tree through the same branch view. A drafted Scratch↔drafted-source move therefore uses the ordinary
`moved` facts, review, inverse, Apply and Discard paths instead of a Scratch-specific move path.
Availability lookups in a branch view follow the same
listing: a surviving document (and a deleted folder the view places it under)
answers `available` at its deleted-at location, never `deleted`, so a review
address opens its draft; live lookups still answer `deleted`. A new live node at a surviving document's path makes that
path `ambiguous` in the branch. A path with two visible nodes answers `ambiguous`;
normalization is a write operation, while `treeState` reports each document's own state.

`branch-ownership.ts` is the single rule for which branches may hold a document:
the branch's project, or the account owner's personal `user://` source. End of
use, Discard, purge, repair, and reveal count every active branch that may hold
the row, so one hidden `user://` document can be shared by branches in several
projects of one account, never another account's. Never replace this rule with
a project-only check.

`identityStatus(view, ids)` distinguishes visible, branch-hidden, gone,
deleted, and malformed/unspellable identities. A hidden row with no active use
is gone and may be repaired asynchronously. Link presence and file facts use
this status; hidden rows outside the selected view are absent. Discarded tombstones also
have diagnostic lineages, so known-id file access can deny access with their
removal record; this never grants content access or makes them visible.

Anything deciding whether a node may stand at a path asks as a kind (document
or folder) through one rule. Create refuses an occupied claim; moves, restores and Apply
allocate a free leaf name but refuse a document blocking an ancestor. A
folder holds its document alias (`Lore.md` holds `Lore`); folders never clash
with folders through it. Generic browsing never asks as a kind, and a path two
nodes share answers a clash, never a pick.

An address consumer that already carries a target kind is not making a
namespace claim. Folder-link preparation passes `directory` to
`inspectTreeLocation`, so it can select the folder from a legacy same-address
folder/document collision instead of letting document-first inspection hide it.

## Lifecycle rules

A draft-created document is a real row with empty live content; its text lives
in its draft until Apply. Live create may reveal a hidden candidate instead
of inserting a twin. `document_forwards` preserves a client-minted ID when a
create joins an existing draft document. Placement reveals targets and
ancestors; terminal end-of-use tombstones an unused row, releases its content
storage, and prunes empty hidden ancestors. A drafted create's Undo is not end
of use: it sets the branch row's `deleted` fact, so the node, its content
storage and the branch's active draft stay for Redo. Closed draft identity rows
remain.

`acquireTreeScope` (`mutation-scope.ts`) is the one verified acquisition for a
tree mutation whose namespaces are discovered, not known: end of use, Discard,
hidden-node repair, Apply's reveal and restore, and the inverses of moves and
deletes. Its `placements` lock the sources of placements no row names yet (a
move's undo returns to its old folder), each where that folder is now; its
`branches` lock where each branch has its documents (physical and effective)
and where every folder it holds sits now, including documents with only a held
folder (a move undone to no row): the effective placement is the read model,
not the cleanup footprint, which a masked move's folder is part of. `sourceIds`
lock a drafted move's destination.
`live-tree-state.ts` reads a document's live state as an edit history's tree
entry records it, and moves a document back to a recorded placement; a deleted
folder there is `folder_missing`, never recreated. It locks the namespaces it
read, re-reads, then takes document locks. A moved scope throws and the caller,
which owns the transaction, aborts and rediscovers. Hidden-node repair uses the
same seam in its own transaction and reports after commit.
Tree writes return changed identities; ContextFS, the mover, Apply, and Discard
refresh the catalog in their own surrounding transaction.

Sibling order is part of effective placement. Parents are either `default` (folders first, then
numeric-aware names) or `manual` (stored ranks in byte order: every SQL comparison or `ORDER BY` on
`rank` uses `COLLATE "C"`, matching `compareCatalogSiblings` in `@meridian/resource-replica`, which also defines the default order). Position commands carry start/end or
before/after one sibling identity; the server resolves the anchor and allocates the rank while the
namespace lock is held. Draft-Work placement carries the same position fact, so pending detection,
Apply, Discard, and inverse operations cannot erase a reorder. Settlement reconciles only the
parents the document left or entered. If an inverse restores a ranked fact after its parent baseline
was cleaned up, it rebuilds that baseline before reinstalling the saved rank.
A batch that arrives together (an import's reveal) is placed in one allocation (`placeArrivedBatch`); export walks each source depth first, children in this order (`export-inventory.ts`), so the archive follows the tree.

## Removal facts

`tree/removal.ts` is the removal record's one owner: `createDocumentRemoval`
writes it, `restoreWorkDocuments` clears it for a Work Restore,
`restoreDocument` clears one document's own delete (below), and
`readRemovalRecords` reads it (actor names joined as they read now) through the
handle its caller gives. Adapters call the reader directly; domain code that
needs a seam (the reply save fence, the model's file tools) takes the narrow
`DocumentRemovals` port, built by `createRemovalRecords`. Callers must
authorize identity access before exposing a record (availability does so through
its existing classification). `ports/document-removal.ts` holds the kernel and the
collab port, so collab need not import a context adapter. A removed document
refuses as agent-edit's `DocumentNotFoundError` carrying its record in
`removal`. A writer's Discard never sets the Work-cascade restore marker.
Retractions name `reply_rolled_back` or `create_failed`; both repair paths name
`repair` (one `DocumentRemovalCause`, from contracts). A model's delete names its
chat (`deleted_by_thread_id`, actor `agent` with the chat's title) and keeps the
chat's owner in `deleted_by_user_id`, who stands in once the chat is gone.

`DocumentRemoval.remove` is the shared kernel for tree delete, overwrite, Work
cascade and last use, and returns exactly the documents it tombstoned. It is
built at the composition root (`lib/compose.ts`), not by collab. Callers take
Work and namespace locks, then the complete sorted document mutation-lock set
before any document row lock. The kernel writes the record, collects the Works
of all tree uses, and registers the record with collab (`registerRemoved`); a
discard also closes the drafts it ends (`closeDiscardedDrafts`).
Independent removal retires uses; Work cascade retains hidden creations' uses
so `restoreWorkDocuments` brings their membership back with the tombstone (the
rule lives beside the Restore it serves). Retained uses are inactive while their
document is tombstoned: tree membership and pending counts filter document
liveness. Restore never reopens a closed draft; the cascade recounts the Works
whose retained uses reactivate through the projects projection.

Production Work sources are Scratch (historical Work uploads were live too);
file policy routes both schemes live and draft admission rejects them. A hidden
creation there is not a supported production write. Legacy schemas nevertheless
permit such rows, so cascade and cutover preserve their membership as well as
their bytes rather than turning Restore into an orphan eligible for repair.
Storage release owns no lifecycle: only `discarded` removals release bytes, and
draft rows are never deleted by it.

Pending counts: every Work the removal changed (tree uses, closed drafts' Works)
goes to `WorkProjectionMutation.recountAfterCommit`, which skips a Work the
caller already holds through the projection (Discard, a branch create's
retraction) and recounts the rest in a separate root transaction after commit,
because the removal holds document locks and may not take a Work lock. End of
use recounts nothing itself: every caller holds the branch's Work. Folder
deletion locks the complete pre-split subtree, hidden boundary documents
included, before the split updates any document row. Rollback delivers nothing.

## Restoring one document

`restoreDocument` is the one restore of a deleted document: Apply of a draft
that outlived the delete (D79), a reply's rollback, the turn card's Undo, and
writer Undo or Trash Restore through the project restore endpoint. Interactive restores share
`context/tree-edit-admission.ts`: bound grants enter the Work projection seam
before `acquireTreeScope`; each caller owns the transaction retry. A reversing
caller names the removal it reverses (its
time and the `location_version` it wrote), so a later, different removal
answers `superseded`; Apply names none, and calls it only for a click that
carries the writer's `restore` (D79); a click without it that meets a deleted
document answers `needs_restore` and changes nothing. A draft that a removal
closes stores `closed_cause` `document_removed` (a writer's Discard stores
`discarded`). A living document answers
`already_living`. Discards, Work cascades and deleted sources or projects
answer `refused`: a Work's own Restore owns its cascade. It places the document
through `placeLive` (placement's ancestry and one name-claim rule: a living
folder at a path is reused, a deleted one restored). A taken leaf counts up to
the free name; the inverse boundary reports a document blocking an ancestor as
`ancestor_taken`.
It settles arrivals and refreshes the catalog through ports its caller passes,
and never touches a draft.

Every arrival returns its actual free placement. Live moves, drafted moves and
their inverses, restores, and Apply placements therefore count up rather than
refusing a leaf-name collision. After a live write, `normalizeNames` looks up only hidden nodes whose indexed claim meets the installed claim and makes those nodes yield in the same transaction; visible wins, then a hidden folder, then the earlier `(created_at, id)`. Folders persist the contracts codec’s document alias so opposite-kind lookup stays indexed.

## Lock and identity contracts

Before the first document lock, callers take in-process leases, thread/Work and
branch rows, sorted namespace keys, then document locks and row locks. Work/branch
lifecycle locks use the FK-compatible mode required by the caller. Never take a
namespace lock while holding a document lock.

Location claims and history use location-only CAS tokens. A move snapshots the
subtree, checks the final path, handles hidden splits/absorbs, and then records
history and versions. Apply reveals through placement; it brings a deleted document back only
through `restoreDocument`, a recorded restore, never as a side effect of a
write. It does not move nodes. Tree code never refreshes the catalog independently of its caller.
