# Tree Apply

A press's tree half (`adapters/drizzle-press.ts`, [the press](press.md)) runs the tree Apply:
`createApplyTreeOperations` in `adapters/drizzle-apply-tree.ts` for Apply, `discardTreeRecords`
for Discard, and `undoApply` / `restoreDiscard` for their Undo. The text half is the press's own.

## The tree cut

A press's tree half is the package's `applyDraft` (`adapters/drizzle-apply-tree.ts`), run with
`treeListStore.submit` in the list that holds the document (`tree_node_ids.list_id`: the
project's, or the account's for `user://`), in the press's own transaction. Its `only` is the
document's item: the pending records made on it, and a drafted delete of a folder above it that
took it along; the package adds what they stand on (`prerequisites`): the drafted creates of
the nodes they need, and, for each Work-created folder above where a record acts, that folder's
last drafted delete or restore before the record, so the folder lands as it stood when the record
was drafted (a card Undo of its restore then finds it in live). A folder's delete drafted after
the document left it, or after the record, stays pending. Earlier records on the same facts come
too. The press carries `saw`: the cut the draft list read its rows at (each list's id and
state vector, read before the rows; `treeCutOf`). A record admitted after it stays pending
(`after_press`); a cut naming another list (one rebuilt under a new id) is no cut, and a scope left
out is the server's own cut. A cut ahead of the server is a 503 that stores nothing. A text-only
item (`half` absent and no tree record named) leaves a pending move or delete pending, except a creation only the Work shows: the tree half
runs for any item with a pending create, which lands whole.

## Owners

**A tree command is judged by every owner its effect touches.** A press's Apply and its Undo change
notes that may be another Work's or a chat lineage's, not the branch's. One thing says which
sources a record changes: the replay that places it (`Change.sources`, `packages/project-tree`).
The server never works it out from parent chains. `closed` is asked of that answer three ways:
which owners to lock (an estimate), which records may commit (the judge, under the locks), and what
stayed and why (the answer).

*Estimate, before the locks* (`withTreeOwners`, `shared/tree-owners.ts`). Apply: the `sources` of
each pending record of the branch in the Work's view, and where live has each node those records and
the items name. Undo of an Apply: the `sources` of each copy the Apply made (`madeBy`), where live has each
of those nodes, and where each document with an applied text effect stands. It is a guess and can
miss without any race: an Apply that moved six notes out of six folders, whose folders live then
moved into six other sources, returns each note to a source the estimate never saw. Its owners are
locked with the branch's in the same `mutate` call (Works sorted by id, then lineages, before lists
and documents). Never take a missed owner's lock inside a running attempt.

*Judge, under the locks* (`TreeOwners.judge`). It reads which of the estimate's `context_sources`
rows still exist, in one query, and answers per source:

| Source | Judge | Apply's item | Undo |
|---|---|---|---|
| No row (a Work or chat purged) | `gone` | `left_out purged`, the record stays pending | `left_out purged` for the node |
| Work archived or deleted; chat lineage with no live member | `closed` with `why`, `owner`, `ownerKey` | `returned` | held |
| Anything else: an open Work or chat, a project source, the account's files | open | lands | taken back |

Every source has a row while it exists, the account's files included, so "no row" is gone, not
ownerless. Reading existence under the locks covers a purge that lands between the estimate and the
lock; without it a purged chat's source would read `chat_frozen` for one press, and the step would
wait for an owner that cannot reopen. To the package both `gone` and `closed` are
`closed(source) === true`; the server turns the `left` record into the right line by asking the judge
again. A source the estimate did not read is answered `gone` and remembered. At the end of the tree
half the attempt throws `TreeOwnersMoved` with the whole set of them, the transaction rolls back, and
the command runs again with all of them added: every missed owner at once, and each restart
adds a source, so it ends (one that names nothing is allowed four). Because the package asks about every source a committing record changes,
a missed owner can never commit.

`applyDraft` and `undoApply` take that predicate: a record whose effect would change a closed
source stays pending, and the plan is made again without it, so nothing that commits touches a
closed owner's notes. A record standing on a held one is `closed` too, with that source, so a note
whose folder's create is in archived notes says so and not `needs`. A press answers such an item
`returned`, the rest landing. The restore Apply makes so a document's
text can land (`restoredByApply`) is made only for a document whose source is open.

The file policy's own owner reader (`loadPhysicalOwnership`, `file-policy/adapters/drizzle-file-facts.ts`)
stays separate: a grant is about a document's content where it stands now, live's placement
first, while a tree command's owners come from where its records put things. Sharing it would
bring back the miss of move destinations and folders.

**The day-30 purge** (`recovery.purgeDiscards`, `adapters/drizzle-discard-purge.ts`, run hourly
beside `purgeWorks` and `purgeDocuments`) deletes each press and unpress command row past 30
days, which cascades its text effects; a Restore after that finds no press and takes nothing
back. A drafted create is not the press's: the tree purges it on its own clock
(`purgeUnviewed`), and the tree's `discarded` settlements stay. Trash's listing has no clock: it
lists whatever still exists, which is what restores.
