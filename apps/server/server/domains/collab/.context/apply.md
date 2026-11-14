# Frozen text Apply

[Frozen Apply clicks][frozen] and [later action wins][later] hold the click contract.
`adapters/drizzle-apply-click.ts` owns the atomic storage operation.

`domain/apply-click.ts` keeps the schema with the frozen optimistic base and patched
blocks: independently built schemas have distinct node and mark types, which the merge
kernel can't mix. Receipt membership is classified at that cut, not replayed onto live.

The `restore` check runs under the Work's and branch's locks, before the list's, so a
delete the writer's view didn't show answers `needs_restore`, however late it landed: nothing
changes, the draft stays pending, and the answer is stored, so a replay returns it. The client
asks before sending a new click with `restore`; with it, the document's `restore` record and the
Apply are one `submit`. Apply reads the addressed document's own row in the Work's tree
(`branch_tree_nodes` against `tree_nodes`), not a branch-wide listing.

The route authorizes a deleted item at its source through the draft destination
(`restoreGrant`), not a live grant. A drafted delete of a document live deleted too
uses `restoreGrant` alone: the branch view has no draft of it to grant. When a delete
commits after the route resolved the item, its authorization or the transaction's
grant confirmation refuses the live grant, nothing is claimed, and the route runs the
click once more, which resolves the item as deleted.

Editor Undo sends an `unapply` command for the original Apply command (`POST .../branches/:branchId/unapply`: the command's own records name its documents, the URL names none). This path
uses the forward-inverse kernel directly against live history, not the model/turn
reversal planner, and folds only the reversed groups out of the current review base.

Every Apply, Un-Apply, Discard and chat-card Undo or Redo (`reverse_turn`, `reversal.md`) is one `commands` row (`shared/commands/`, which every kind of request shares; `adapters/drizzle-document-commands.ts` is the document side).
`runCommand` inserts it first and runs the effect in a savepoint under the claim, and the effect
enters the Work boundary after it (`CONTEXT.md`, the lock order). A refusal raised after the claim (`ApplyClickRefused`, a draft that closed under the
append door, a Discard's `stale` or `draft_changed`) rolls back to the savepoint and is stored as the
outcome, so a resend under the same id gets the same refusal and "Try again" needs a new id. A miss
the server retries itself (`TreeScopeChangedError`, `DraftCasConflictError`,
`BranchDiscardScopeChangedError`) rolls back past the claim and the attempt runs again. A request
turned away before the transaction (access, malformed, unknown document) stores nothing. Un-Apply
reads only the effects whose draft's branch is the URL's. `GET /api/commands/:id` returns the stored outcome to the
account that sent it; `POST /api/commands/:id/resolve` (`lib/command-route.ts`) waits on a held key and
answers the stored outcome, or stores `never` where there is no row (a late request under the id then
answers `command_conflict` on an old-shape route).

The command stores one full starting base plus per-group deltas, not a full
before/after document for every group. A later Un-Apply rebuilds the complete delta
chain before selecting effects that remain active, so an earlier partial reversal
can't remove the starting point or an intermediate delta.

`apply.measured` emits compile and Work-boundary times by command id. The draft
append's lock-to-root-commit `holdMs` joins them through an async diagnostic scope. Apply
takes no draft lock outside that append, so `holdMs` covers its whole hold.

The API-core recipe is [atomic Apply](qa/atomic-apply.md). It
does not stand in for integrated browser FIFO and optimistic-review verification.

## The tree cut

A click's tree half is the package's `applyDraft` (`adapters/drizzle-apply-tree.ts`), run with
`treeListStore.submit` in the list that holds the document (`tree_node_ids.list_id`: the
project's, or the account's for `user://`), in the click's own transaction. Its `only` is the
document's item: the pending records made on it, and a drafted delete of a folder above it that
took it along; the package adds the drafted creates they stand on and earlier records on the
same facts. The click carries `tree.revision`, a digest of the Work's row on the document
(`md5` over its source, parent, name, rank, `deleted` and `exists_only_in_draft`), and answers
`changed` when the row says something else now. A record that cannot land (a move into itself,
a move of what live has in Trash) lands nothing of the item: the click is `refused` with
`ancestor_taken` and the draft stays pending. A text-only click leaves a pending move or delete
pending, except for a creation only the Work shows, which lands whole.

Lock order inside the click: Work, branch, the list's key (`treeLists.lock`), the document's
mutex, then the writes: the list's records and rows (`submit`), the closed draft's resync, draft
rows. The rows are written under the document's key because derivation certification takes that
key and then the document's `tree_nodes` row. Nothing takes a document mutex before the list's
lock.

### One Apply over any nodes, Un-Apply, Undo of a Discard

An Apply is one command over any selection of nodes, folders included: `POST
.../branches/:branchId/apply` (`ApplyItemsClick`) carries, per item, a tree cut and/or a text
cut. The per-document click (`.../documents/:documentId/draft/apply`) is the same command with
one item (`itemsOfClick`), and Apply all sends every item at once; a loop of per-document
commands could be taken back only one at a time. `adapters/drizzle-apply-click.ts` runs the tree
cuts first (`applyDraft` over all the chosen records in each list), then each document's text
cut in id order, all in one transaction. A text draft closed under the click answers `closed` for
the whole command; a row that holds another revision answers `changed` and nothing lands. An item
that cannot land stays pending; none landing is `refused` `ancestor_taken`.

The command records its whole effect. Tree half: one `apply_command_trees` row per list, with the
list's state vector right after, the created documents' journal heads once the text is in, the
live restore records the Apply made (a "Restore and apply" brings a document out of Trash before
its copies), and the nodes it touched. Text half: `apply_command_effects`, one row per group per
document. Un-Apply reverses all of it, across every document: `undoApply` in each list (the copies
and the restores leave live), then each document's text groups. It runs the tree half before any
write and after every check that can end the command quietly, so a refusal (`gone`: the list moved,
or a created document has text past its heads; `superseded`) stores nothing of either half. A text
group a later edit overlaps stays applied and is named in `skippedGroupIds`; when every group stays
and the tree half comes back, the answer is still `unapplied`, with no reversed groups. Lock order:
the lists' keys, then the keys of the documents the Apply wrote text in or created.

Every route that writes documents on behalf of a command takes the same grants before it runs:
Apply the draft's and the live grant on each document (and a restore grant for one live has
deleted), Un-Apply and Undo of a Discard an edit grant, or the restore grant, on each document the
command's own record names (`commandDocuments`). A folder has no file of its own: the project's
owner is its only writer, which the branch's identity step proved. A creation only the Work
showed, whose draft a Discard closed, has no tree row for any target to resolve until Undo of
the Discard copies it back; it takes no grant, and the Work's lock (lifecycle) is its authority.

`POST .../branches/:branchId/undo-discard` (kind `undo_discard`) copies back both halves of a
Discard on the Work's current branch (`ensureActiveForWrite`: a whole Discard closed the branch it
ran on). The tree records the Discard settled come back as pending copies (`restoreDiscard`). The
text drafts it closed (`discard_command_drafts`, written by the kernel) come back as new active
drafts holding the closed ones' bytes: a closed draft keeps `state` and its journal until its
document's content is purged. The next live pull catches a copy up to the live text that moved
meanwhile. Each half is copied once. A document the Work has drafted again since keeps its newer
draft, and the Discard's text for it is counted in `leftOut`. With nothing to copy, the answer is a
refusal that says why: `already_restored`, or `nothing_to_restore` (the Discard settled and closed
nothing that still exists). Lock order: the Work, the owner's active branch, the lists' keys, then
the keys of the documents the copies act on.

[frozen]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/apply.md#the-click-owns-its-meaning
[later]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/apply.md#when-draft-and-live-both-changed-the-later-action-wins
