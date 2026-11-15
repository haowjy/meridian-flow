# Frozen text Apply

[Frozen Apply clicks][frozen] and [later action wins][later] hold the click contract.
`adapters/drizzle-apply-click.ts` owns the atomic storage operation.

`domain/apply-click.ts` keeps the schema with the frozen optimistic base and patched
blocks: independently built schemas have distinct node and mark types, which the merge
kernel can't mix. Receipt membership is classified at that cut, not replayed onto live.

A document live has in Trash comes back whenever the click lands records on it, with no question
asked: the answer says `restored { documentId }` in `settled`. Apply reads the addressed document's
own row in the Work's tree (`branch_tree_nodes` against `tree_nodes`), not a branch-wide listing.

The route authorizes a deleted item at its source through the draft destination
(`restoreGrant`), not a live grant. A drafted delete of a document live deleted too
uses `restoreGrant` alone: the branch view has no draft of it to grant. When a delete
commits after the route resolved the item, its authorization or the transaction's
grant confirmation refuses the live grant, nothing is claimed, and the route runs the
click once more, which resolves the item as deleted.

Editor Undo sends an `unapply` command for the original Apply command (`POST .../branches/:branchId/unapply`: the command's own records name its documents, the URL names none). This path
uses the forward-inverse kernel directly against live history, not the model/turn
reversal planner, and folds only the reversed groups out of the current review base.

The groups of one click are a chain: group *k* is compiled and merged against the base with groups
1..*k*−1 already applied, one live update each. Merging each group against the click's base would
see its sibling groups as concurrent changes, and two groups that change one structure (one removes
a paragraph break, the next adds one nearby) would undo each other. Un-Apply inverts the latest
group first, because a group's update builds on the earlier groups' items; an earlier group stays
when a later one was edited in live.

Every Apply, Un-Apply, Discard and chat-card Undo or Redo (`reverse_turn`, `reversal.md`) is one `commands` row (`shared/commands/`, which every kind of request shares; `adapters/drizzle-document-commands.ts` is the document side).
`runCommand` inserts it first and runs the effect in a savepoint under the claim, and the effect
enters the Work boundary after it (`CONTEXT.md`, the lock order). An Apply or Un-Apply stores no refusal: each item lands or comes back in `settled` (below), and the row is `done`. A draft that closed under the append door can't happen mid-command: the Work's and the document's keys are held. A miss
the server retries itself (`TreeScopeChangedError`, `DraftCasConflictError`,
`BranchDiscardScopeChangedError`) rolls back past the claim and the attempt runs again. A request
turned away before the transaction stores nothing: a malformed click (a bad snapshot, patches or group ids) is a 400, and one whose cut is ahead of what the server holds (`unsynced`: a room's unacknowledged changes, or tree records the server's list lacks, `covers(list, saw)`) is a 503 the client sends again with the same id. `GET /api/commands/:id` returns the stored outcome to the
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
same facts. The click carries `saw`, each list's state vector at the press; a record admitted after
it stays pending (`after_press`). A record that cannot land (a move into itself, a node that is
gone) lands nothing of the item and the draft stays pending: the answer names it in `settled`.
A text-only click leaves a pending move or delete pending, except for a creation only the Work
shows, which lands whole.

**Settled, per item.** An Apply never answers a whole command with a refusal. `ApplyClickResult` is
`applied` with `applied[]` (what landed) and `settled[]`, which says what happened to each item that
did not land: `already { applied }` (an Apply took its tree records earlier), `overtaken { discarded |
removed, by }` (a Discard took them, or its text draft was closed by one; or an Apply's delete
removed the document), `left_out { items, why }` (`would_loop`, `purged`, `after_press`, `needs`,
`changed_since`). One read decides it for the tree half, `lastSettlementOf` (`drizzle-settlement-of.ts`):
the last settlement of a node's records in the Work's branch, which names the command and whether it
applied or discarded; Discard's per-item answer reads the same. A text cut on a draft that is closed
reads the draft row (`closedDraftSettlement`): closed by a Discard or a swap is `overtaken
discarded`, by a delete or a removal `overtaken removed`, with no command `left_out purged`. An item
whose tree half did not resolve keeps its text pending too. An Apply that lands nothing emits
`apply.answered_without_landing` with the reasons.

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
cut in id order, all in one transaction. An item that cannot land stays pending and is named in
`settled`; the others land.

The command records its whole effect. Tree half: one `apply_command_trees` row per list, with the
list's state vector right after, the created documents' journal heads once the text is in, the
live restore records the Apply made (a "Restore and apply" brings a document out of Trash before
its copies), and the nodes it touched. Text half: `apply_command_effects`, one row per group per
document. Un-Apply reverses all of it, across every document: `undoApply` in each list (the copies
and the restores leave live), then each document's text groups. It runs the tree half before any
write. A change it cannot take back (`changed_since`, `has_text` for a created document with text past
its heads, `purged`) stays and is named in `settled` as `left_out`; one already taken back is quiet. When
nothing was left to take back, the answer is `already { unapplied }`, and so is a second Un-Apply of a
delete. When the Work's purge took the tree rows of the Apply, the document it moved or deleted is
`left_out purged`. A text
group whose reversal would change a word holding writing made after the Apply (the word rule,
`reversal.md`) stays applied and is named in `skippedGroupIds`; when every group stays
and the tree half comes back, the answer is still `unapplied`, with no reversed groups. Lock order:
the lists' keys, then the keys of the documents the Apply wrote text in or created (and of the
drafts the Apply closed, below).

**Un-Apply is read by the Apply, not by a branch.** Its effects and tree rows are found by the
Apply's command id and the account; the URL's branch only names the Work. A Restore moves a draft
to another branch, a Discard closes it, and neither changes what the Un-Apply finds. A text effect
whose draft is **open** is reversed in the draft's base as before (`reverseBaseHalf`) and marked
`draft_reversed`. One whose draft is **closed** is reversed in live only: its row gets
`unapplied_by` and `unapplied_seq` (a value taken from `apply_command_effects_unapplied_seq` under
the Work lock, since `commands.created_at` is the transaction start, not the lock order), leaves
`draft_reversed` false, and the answer says `draftHalfWaits`. A purged draft has no draft half.
A closed branch alone does not stop the tree half.

**Reopening a closed draft** is one function, `reopenDrafts` (`drizzle-reopen-drafts.ts`), called by
Restore and by Un-Apply of an Apply whose drafted delete closed the Work's drafts (`closed_by` = the
Apply). It flips each row to active in the Work's current branch, closes a newer active draft of the
document under the calling command's id, then **replays** the Un-Applies the draft waited on, and
resyncs the reopened drafts' own lists. The replay reads the draft's effects with `unapplied_by` set
and `draft_reversed` false, orders them by `unapplied_seq` and, within one Un-Apply, by descending
ordinal, rebuilds each effect's base from the Apply's rows (reversed ones included: `baseStart` is
stored once), and runs the same body as the open path (`reverseBaseHalf`): merge the group's text
out of the base, remove its Apply records. Without it the base keeps text the Un-Apply took out of
live, and a pull merges that deletion into the draft's own text. `draft_reversed` is what stops a
second replay of an effect the open path already reversed. Un-Apply runs its tree half first, reopens
only the drafts whose documents that half restored (a document the writer restored by hand and
deleted again keeps its draft closed), then reads the bases, so the draft half of its own text
effects on a draft its delete closed runs on an open draft. A tree refusal throws and the command's
savepoint takes the reopen back. Every reopen schedules a live pull for the document.
Where the draft goes: `ensureActiveForWrite` with `{ requireActive: false }`, called only when the
Apply closed a draft, so an Un-Apply with nothing to reopen makes no branch; an archived Work whose
branch closed gets a new one.

A newer draft the reopen swaps out is closed with the reopening command's id, and that command
(`undo_discard` or `unapply`) is a Trash entry with that draft as a member, so the swap stays
restorable. The entry query lists `discard` and `undo_discard` commands, and an `unapply` only while a draft
it swapped out is still closed under it; Restore accepts all three; the Un-Apply's answer carries `branchId` for it.

Every route that writes documents on behalf of a command takes the same grants before it runs:
Apply the draft's `command` grant and the live `edit` grant on each document (and a restore grant
for one live has deleted), Un-Apply an `edit` grant, and Undo of a Discard and Discard the draft's
`command` grant, on each document the command's own record names (`commandDocuments`). `command`
ignores the owner's lifecycle (a closed Work or chat, a deleted document), so the route never answers
for a closed owner; the Work lock does, in the command's transaction. A folder has no file of its own: the project's
owner is its only writer, which the branch's identity step proved. A creation only the Work
showed, whose draft a Discard closed, has no tree row for any target to resolve until Undo of
the Discard copies it back; it takes no grant, and the Work's lock (lifecycle) is its authority.

`POST .../branches/:branchId/undo-discard` (kind `undo_discard`) restores a Discard, from the
notice right after it or from Trash; `discardCommandId` may also name an earlier restore (see
below). The branch in the URL is the one the command ran on. The tree records the Discard settled
come back as pending copies (`restoreDiscard`) on the Work's current branch (`ensureActiveForWrite`:
a whole Discard closed the branch it ran on, so a new one is made; a branch row never reopens). Each
text draft with `closed_by` = the Discard is **reopened as the same row** (`reopenDrafts`, above), moved to that branch,
`closed_by` and `closed_cause` cleared: its receipts' origin, authorship and seeds stay keyed to
the draft id, and the model's next write finds an active draft, not a closed one. If the Work has
a newer active draft of the document, the restore closes it first with `closed_by` = the restore's
own command id (`swapped` in the answer): that draft is a member of the restore's entry, and
restoring that entry swaps it back. Nothing is refused because a newer draft exists. The restore marks the owner's
current drafts changed (`draftMembershipChanged`), so the Work's revision moves and its owner hint
goes out even when the pending count stays the same (a swap). A second restore finds no member:
`already_restored` (the tree took its records, or a stored restore named this command). Other
refusals: `expired` (the command is older than `DELETION_RETENTION_DAYS`), `document_purged`
(what the entry held was purged: a node, or text drafts a document purge deleted),
`nothing_to_restore` (its tree records belong to another Work), `work_purged` (the Work and its
branches are gone; the route lets the command through instead of answering 404 so the refusal is
stored). A branch of another project is a 404 at the route and `not_found` in the store. A Work or
chat that cannot take the restore (archived, deleted, a chat in Trash) bounces: stored `done`, nothing
changed, `restored: 0`, `settled: [{ rule: "returned", why: "work_archived" | "work_deleted" | "chat_frozen" }]`.
The Work lock throws and `closedOwnerBounce` (`adapters/closed-owner-bounce.ts`) turns the throw into that
result in the command's refusal mapper; Discard bounces the same way (`status: "returned"`). Apply and
Un-Apply land on a closed owner, and it stays closed. `listDiscards(projectId)` is the document half of Trash's Discard entries.
Lock order: the Work, the owner's active branch, the lists' keys, then the keys of the documents
the copies act on, then the draft rows. The browser rejoining a restored draft's room is the
client's.

[frozen]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/apply.md#the-click-owns-its-meaning
[later]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/apply.md#when-draft-and-live-both-changed-the-later-action-wins
