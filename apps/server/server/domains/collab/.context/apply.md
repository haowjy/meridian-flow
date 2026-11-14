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

Editor Undo sends an `unapply` command for the original Apply command (`POST .../branches/:branchId/unapply`: the command's own records name its document, the URL names no document). This path
uses the forward-inverse kernel directly against live history, not the model/turn
reversal planner, and folds only the reversed groups out of the current review base.

Every Apply, Un-Apply, Discard and chat-card Undo or Redo (`reverse_turn`, `reversal.md`) is one `document_commands` row (`adapters/drizzle-document-commands.ts`).
`runCommand` inserts it first and runs the effect in a savepoint under the claim, and the effect
enters the Work boundary after it (`CONTEXT.md`, the lock order). A refusal raised after the claim (`ApplyClickRefused`, a draft that closed under the
append door, a Discard's `stale` or `draft_changed`) rolls back to the savepoint and is stored as the
outcome, so a resend under the same id gets the same refusal and "Try again" needs a new id. A miss
the server retries itself (`TreeScopeChangedError`, `DraftCasConflictError`,
`BranchDiscardScopeChangedError`) rolls back past the claim and the attempt runs again. A request
turned away before the transaction (access, malformed, unknown document) stores nothing. Un-Apply
authorises through the effect's draft: `apply_command_effects.draft_id` names the draft whose
branch must be the URL's. `GET /api/document-commands/:id` returns the stored outcome to the
account that sent it.

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

### Apply of several nodes, Un-Apply, Undo of a Discard

`POST .../branches/:branchId/apply` (`ApplyTreeClick`) is the tree half alone for any set of
nodes, folders included, as one command: `applyDraft` over all the chosen records in each list,
one `apply_command_trees` row per list (the list's state vector right after, and the created
documents' journal heads once the command's text is in). Each item carries the revision it saw;
any other answers `changed` and nothing lands. An item that cannot land stays pending; none
landing is `refused` `ancestor_taken`. The per-document click is the same code with one item.

Un-Apply runs the tree half through `undoApply` in each list the command has a row for, before the
text writes and after every check that can end the command quietly, so a refusal (`gone`: the
list moved, or a created document has text past its heads; `superseded`) stores nothing of
either half. Lock order: the lists' keys, then the keys of the text document and the
documents the Apply created.

`POST .../branches/:branchId/undo-discard` (kind `undo_discard`) restores the tree half of
a Discard command through `restoreDiscard` on the Work's current branch (`ensureActiveForWrite`:
a whole Discard closed the branch it ran on). The server keeps no closed text drafts to restore,
so a discarded document's text stays as the Discard left it. The Discard kernel tags its
settlements with the command's own id; that is how both find them.

[frozen]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/apply.md#the-click-owns-its-meaning
[later]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/apply.md#when-draft-and-live-both-changed-the-later-action-wins
