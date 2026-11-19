# Text Apply

[What a click carries][frozen] and [later action wins][later] hold the click contract.
`adapters/drizzle-apply-click.ts` owns the atomic storage operation.

A text cut (`ApplyTextCut`) is frozen or whole. A frozen cut is the writer's click on an open
room: snapshot, `baseViewDelta`, `groupIds`; the server refuses `unsynced` when its replica
lacks the snapshot, and `malformed` for a group the cut's projection doesn't have. A whole cut
(`{draftId, whole: true}`) is what a tab with no room open sends (Changes rows, folders, Apply
all): `compileClick` cuts at the replica `loadBase` returned, with an empty `baseViewDelta`, and
takes every group of that projection, or, with `groupIds` (a Redo: `redoOf` on the Apply route has the server read what the Un-Apply took from the effect rows it marked, `redoItems`), the named groups the projection holds, passing over the rest. A whole cut with no group
compiles to an empty click; the adapter skips its text and names its item in the answer's `skipped`. Receipts, the compile and
the Un-Apply records are the same for both.

The projection job (`domain/draft-projection.ts`) stores `text_changes`, the review groups of
the draft against its base, with `has_effect`; the owner draft list carries it as the row's
count, so Changes needs no room to say "N text changes".

`domain/apply-click.ts` keeps the schema with the frozen optimistic base and patched
blocks: independently built schemas have distinct node and mark types, which the merge
merge can't mix. Receipt membership is classified at that cut, not replayed onto live.

A document live has in Trash comes back whenever the click lands records on it, with no question
asked: the answer says `restored { documentId }` in `settled`. Apply reads the addressed document's
own row in the Work's tree (`branch_tree_nodes` against `tree_nodes`), not a branch-wide listing.

The route authorizes a deleted item at its source through the draft destination
(`restoreGrant`), not a live grant. A drafted delete of a document live deleted too
uses `restoreGrant` alone: the branch view has no draft of it to grant. A delete that
commits after the route resolved the item doesn't refuse the live grant (`command` ignores it):
the command reads it under its locks and brings the document back.

Editor Undo sends an `unapply` command for the original Apply command (`POST .../branches/:branchId/unapply`: the command's own records name its documents, the URL names none). This path
merges the effect's recorded `live_delta` back out of Live (the same `stands` and `takeOut` the card's
Undo uses, `reversal.md`), not through the model/turn reversal planner, and folds only the
reversed groups out of the current review base.

The groups of one click are a chain: group *k* is compiled and merged against the base with groups
1..*k*−1 already applied, one live update each. Merging each group against the click's base would
see its sibling groups as concurrent changes, and two groups that change one structure (one removes
a paragraph break, the next adds one nearby) would undo each other. Un-Apply inverts the latest
group first, because a group's update builds on the earlier groups' items; an earlier group stays
when a later one was edited in live.

Every Apply, Un-Apply, Discard and chat-card Undo (`reverse_turn`, `reversal.md`) is one `commands` row (`shared/commands/`, which every kind of request shares; `adapters/drizzle-document-commands.ts` is the document side).
`runCommand` inserts it first and runs the effect in a savepoint under the claim, and the effect
enters the Work boundary after it (`CONTEXT.md`, the lock order). An Apply or Un-Apply stores no refusal: each item comes back with each half landed or settled (below), and the row is `done`. A draft that closed under the append door can't happen mid-command: the Work's and the document's keys are held. A miss
the server retries itself (`TreeScopeChangedError`, `DraftCasConflictError`,
`BranchDiscardScopeChangedError`) rolls back past the claim and the attempt runs again. A request
turned away before the transaction stores nothing: a malformed click (a bad snapshot, patches or group ids) is a 400, and one whose cut is ahead of what the server holds (`unsynced`: a room's unacknowledged changes, or a tree cut ahead of the server's list, `covers(list, saw)`; a cut the draft list issued is always covered) is a 503 the client sends again with the same id. `GET /api/commands/:id` returns the stored outcome to the
account that sent it; `POST /api/commands/:id/resolve` (`lib/command-route.ts`) waits on a held key and
answers the stored outcome, or stores `never` where there is no row (a late request under the id then
answers `command_conflict` on an old-shape route).

A resend of an Apply or Un-Apply that arrives while the first request is still committing (an
Apply all of a few hundred documents outlasts the client's 10 s timeout) waits on that request's
claim before resolving or compiling anything (`awaitCommand` in `shared/commands/drizzle-commands.ts`):
an uncommitted claim can't be read, so an insert on its key waits on it and is rolled back. It
waits 5 s, under the client's timeout, and answers the stored outcome, or `running` while the
first still holds the claim; the client sends again on `running`. Without it each resend compiled
every document again before finding the claim taken.
While it runs, a slow Apply holds two pooled connections: the first request's, and one resend's
parked for up to 5 s. The pool is 10 per instance, so about five slow Apply alls at once would
starve every other request.

Each group's effect row also records what the Apply did to the text it merged: `carried`, the
changes of AI edits (`[partId, index]` of a `document_edit_parts` row and of the change in its
`delta`) that sat in the applied change, read on the draft as the click found it
(`compileClick`, `draft-changes.ts` `carriedBy`); and `live_delta`, the blocks of the manuscript
the group changed, before and after (null when Live already held the text). `carried` is why the
card reads "Applied" for a change whatever the text does later; `live_delta` is what Un-Apply takes
out of Live. No Yjs item id is recorded: the draft's Apply record keeps only the command and group
ids the browser's queue reads.

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
took it along; the package adds what they stand on (`prerequisites`): the drafted creates of
the nodes they need, and, for each Work-created folder above where a record acts, that folder's
last drafted delete or restore before the record, so the folder lands as it stood when the record
was drafted (a card Undo of its restore then finds it in live). A folder's delete drafted after
the document left it, or after the record, stays pending. Earlier records on the same facts come
too. The click carries `saw`: the cut the draft list read its rows at (each list's id and
state vector, read before the rows; `treeCutOf`). A record admitted after it stays pending
(`after_press`); a cut naming another list (one rebuilt under a new id) is no cut, and a scope left
out is the server's own cut. A cut ahead of the server is a 503 that stores nothing. A text-only
click leaves a pending move or delete pending, except a creation only the Work shows: the tree half
runs for any item with a pending create, which lands whole.

**The invariant.** Every item an Apply was sent comes back once in `ApplyClickResult.items`, in the
click's order, with each of its two halves answered on that half's own evidence: this command
landed it (`landed: true`, which Un-Apply takes back), or here is what settled it instead
(`landed: false` with `settled` lines). A line beside `landed: true` names what stayed out of the
half or came with it (`left_out`, `restored`). `applied` is derived from `items` for tabs opened
before it. Records that land without being asked for (a prerequisite create, the prefix
`applyDraft` falls back to) belong to no entry.

`adapters/drizzle-apply-click.ts` `apply` is the one place that decides, in this order, under the
Work, branch, list and document keys:

1. `settlementOf` (`drizzle-settlement-of.ts`) for every item: whether the Work still holds the
   node's item (`recordsOfItem`), what settled it last, and the text draft's row. Its tree reading
   ranks the records the press saw (`recordsAdmittedAfter` drops the rest): the node's own, and a
   folder delete whose cascade names it while the folder is still above it in the Work's view. No
   cut (an old tab): the node's own records win. `noteOf` turns a fact into a line (`already` for
   the asked kind, `overtaken` for the other, `left_out purged` for none). Discard's
   per-item answer (B4) reads the same.
2. The text half is open when its cut compiled and its draft is the open row of this branch;
   otherwise its line is fixed now.
3. The tree half (`drizzle-apply-tree.ts`, facts only): per list, the items' records, a restore
   before the copies for a document whose text is open, that live has in Trash and whose records
   hold no delete, one `applyDraft`, then a restore for a document whose own delete did not land
   and that nothing of this command deleted. A document is deleted by this command when a delete
   copy it appended covers it in live afterwards (`deletesCovering`, every covering delete, at
   each folder on the way up).
4. Only those documents' drafts close, under the command's id.
5. Each open text half lands when its document stands in live: one this command deleted answers
   `already removed`, one whose create did not land `left_out needs` (its text stays pending with
   its draft). What the tree half answered never holds text back.
6. `apply.answered_without_landing` is emitted after the commit when no half landed.

The tree half's lines come from its records' fates in `applyDraft`: `left_out` per reason a record
stayed, `already applied` when a create live already holds was superseded, and with nothing
pending, what settled the records. A move or rename that brought the node out of Trash adds
`restored`; a restore this command made is a tree fact too (the tree half is present and landed),
and the text half says `restored`. Three things are on purpose: a restore and a delete copy
covering it can come from one command (`undoApply` takes back both); "records hold no delete" misses
a folder delete hidden behind the document's own older live delete, which then does not cover it;
and when `keepsView` fails, the prefix fallback can land a pending delete of a document the click
asked only text of, whose text then answers `already removed`.

Lock order inside the click: Work, branch, the list's key (`treeLists.lock`), the document's
mutex, then the writes: the list's records and rows (`submit`), draft
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
cut in id order, all in one transaction. Each item comes back once in `items`, each half landed
or settled, as above.

The command records its whole effect. Tree half: one `apply_command_trees` row per list, with the
list's state vector right after, the created documents' journal heads once the text is in, the
live restore records the Apply made (a "Restore and apply" brings a document out of Trash before
its copies), and the nodes it touched. Text half: `apply_command_effects`, one row per group per
document. Un-Apply reverses all of it, across every document: `undoApply` in each list (the copies
and the restores leave live), then each document's text groups. It runs the tree half before any
write. A change it cannot take back (`changed_since`, `has_text` for a created document with text past
its heads, `purged`) stays and is named in `settled` as `left_out`, one line per reason and half
(`tree: true` for tree facts, `false` for text), so the app never guesses which half stayed. One
something else already took back (a chat card's Undo of a rename: the copy is no longer in force)
is `already { unapplied }` with the item. `treeUndone` names the nodes with a fact it took back, so it took something
back when that or `textUndone` is not empty. When nothing was taken back, left or held, the
answer is `already { unapplied }`, and so is a second Un-Apply of a delete. When the tree rows of
the Apply are gone (`treeHalfLostWithBranch`, read from the stored answer's `applied`), the document
it moved or deleted is `left_out purged`; the route answers 404 for a purged Work before the command
runs, so that path is reached only when a chat's lineage branch goes while its Work lives on. A text
group with nothing left to reverse stays: it is named in `textSkipped` and its document in a
`left_out changed_since` line, on every press. Nothing records the skip: it is a judgement of the
text as it stands. The Live half is a merge: the groups come out latest first, each when its
`live_delta` still stands in Live (`changeStateIn`, the rule a draft Undo uses) and as `takeOut`, so
a word the writer typed over an applied change is never removed. A group whose `live_delta` is null
reverses with nothing written to Live. When every group stays and the tree
half comes back, the answer is still `unapplied`, with no reversed groups. Lock order:
the lists' keys, then the keys of the documents the Apply wrote text in or created.

**Un-Apply is read by the Apply, not by a branch.** Its effects and tree rows are found by the
Apply's command id and the account; the URL's branch only names the Work. A Restore moves a draft
to another branch, and that changes nothing an Un-Apply finds. A text effect whose draft exists is
reversed in the draft's base (`reverseBaseHalf`, `reverse-base-half.ts`): the group's text is merged
out of the base and its Apply records come out of the draft. A purged draft has no draft half. A
closed branch alone does not stop the tree half. An Apply of a drafted delete leaves the Work's
drafts of that document open, so an Un-Apply has no draft to reopen, swap or replay.

Every route that writes documents on behalf of a command takes `command` grants before it runs:
Apply the draft's and the live document's on each item (a restore grant for one live has deleted),
Un-Apply the live document's, and Discard and its Restore the draft's, on each document the
command's own record names (`commandDocuments`; for a Discard, its effect rows). `command` ignores lifecycle (a closed Work or chat,
a deleted document) and keeps the person and agent terms, so the route never answers for a closed
owner; the owners' locks do, in the command's transaction (below). A folder has no file of its own: the project's
owner is its only writer, which the branch's identity step proved.

**Discard is one server command over change ids** (`adapters/drizzle-branch-discard.ts`,
`POST .../branches/:branchId/discard`). Each item names a document and what it takes: `text` is
`"all"` or the change ids to take out, `tree` the branch's move, delete or create. The text half
appends to the draft's own text the update that makes the draft read as the base for those
changes (`discardChanges`, `content-merge/discard.ts`), exactly as a model's edit appends, so the
draft stays open and its history, receipts and room are untouched; the writer's later typing is
never rewritten. One `discard_command_effects` row per document keeps the delta (draft side before,
base side after, `StoredDelta`) and is what Restore reads; the tree half settles the Work's pending
records `discarded` with the command's id, as before. A change the writer has since written over
is not taken back by Restore, and nothing says so. `closed` in the answer names the items that
left Changes whole (`text: "all"`, or a tree-only item with no text held); the draft row is never
closed. `whole` is true when the Discard took whole drafts (`text: "all"` on every item) or all
of them; only such a Discard is listed in Trash, and a Discard of single changes is final but for
its Undo (the notice's, or Ctrl+Z). Discard all runs the same path with `text: "all"` on every
draft. A Work purge deletes its drafts' rows (`disposeBranchLocked`), and their rooms close after
commit.

`POST .../branches/:branchId/undo-discard` (kind `undo_discard`) restores a Discard, from the notice
right after it or from Trash; `discardCommandId` may also name an earlier restore. Each effect row's
delta is read backwards (`restoreChanges`, `standsIn`): the changes that still stand on the draft's
current text come back as one more appended update, the rest are gone silently, and the effect row is
marked `ended_by` when everything (or nothing) came back so it leaves Trash. The tree records come
back as pending copies (`restoreDiscard`) on the Work's current branch (`ensureActiveForWrite`). Restore never refuses and
reads no clock; one that brings nothing back is `done` with `restored: 0`. A command of another kind
or one the day-30 purge took finds nothing. A purged Work's branch is a 404 at the route, and a branch
of another project is a 404 too. A Work or chat that cannot take the restore (archived, deleted, a
chat in Trash) bounces: stored `done`, nothing changed, `restored: 0`,
`settled: [{ rule: "returned", why: "work_archived" | "work_deleted" | "chat_frozen" }]`.
The Work lock throws and `closedOwnerBounce` (`adapters/closed-owner-bounce.ts`) turns the throw into that
result in the command's mapper; Discard bounces the same way. Apply and
Un-Apply land on a closed *branch* owner, and it stays closed; they judge each item by its file's own owner (below). `listDiscards(projectId)` is the document half of Trash's Discard entries: one per Discard of whole drafts (`whole`) with an effect not yet ended.
Lock order: the Work, the owner's active branch, the lists' keys, then the keys of the documents
the copies act on, then the draft rows.

**A tree command is judged by every owner its effect touches.** Apply and Un-Apply change
notes that may be another Work's or a chat lineage's, not the branch's. One thing says which
sources a record changes: the replay that places it (`Change.sources`, `packages/project-tree`).
The server never works it out from parent chains. `closed` is asked of that answer three ways:
which owners to lock (an estimate), which records may commit (the judge, under the locks), and what
stayed and why (the answer).

*Estimate, before the locks* (`withTreeOwners`, `shared/tree-owners.ts`). Apply: the `sources` of
each pending record of the branch in the Work's view, and where live has each node those records and
the items name. Un-Apply: the `sources` of each copy the Apply made (`madeBy`), where live has each
of those nodes, and where each document with an applied text effect stands. It is a guess and can
miss without any race: an Apply that moved six notes out of six folders, whose folders live then
moved into six other sources, returns each note to a source the estimate never saw. Its owners are
locked with the branch's in the same `mutate` call (Works sorted by id, then lineages, before lists
and documents). Never take a missed owner's lock inside a running attempt.

*Judge, under the locks* (`TreeOwners.judge`). It reads which of the estimate's `context_sources`
rows still exist, in one query, and answers per source:

| Source | Judge | Apply's item | Un-Apply |
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
whose folder's create is in archived notes says so and not `needs`. Apply answers such an item
`{ landed: false, settled: [returned] }`, the rest landing. The restore Apply makes so a document's
text can land (`restoredByApply`) is made only for a document whose source is open.

**Un-Apply's answer is a partition.** Everything of the Apply still applied before the press is in
exactly one place: taken back (`textUndone`, `treeUndone`), left as the text and tree stand
now (`left_out`, `textSkipped`), or held (`UnapplyClickResult.held`, one entry per node: `tree`
when a tree fact of it is held, `groupIds` the text groups of it that are, `why`, `owner` and
`ownerKey`). Something already taken back is in none; a text group an earlier Un-Apply took back is
never held. Text is named per document (`{ node, groupIds }`): one change made in two documents
has one group id, and a press can take it back in one of them and leave it in the other, so a
Redo replays `(document, group)`, never the id alone. In `drizzle-apply-click.ts` `unapply`, under
the locks:

1. The tree half runs first (`undoApply` with the judge). `left` for `closed` asks the judge again:
   `closed` is a held entry with `tree`; `gone` is `left_out purged`. `already` is in no list.
2. Then, per document, the text effects already taken back are dropped, and a document with none left
   is skipped. For the rest, where the document stands *after* the tree half is read, and a closed
   source holds every remaining group in that node's entry. Otherwise the inverse runs as before.
   A node whose move back is held while its text, now in an open source, goes back is in
   `textUndone` and in `held` with `tree: true` and no groups.

The `returned` lines in `settled` (one per owner and reason, with `owner` and `items`) are derived
from `held`, for the words and for a tab opened before. `already { unapplied }` with no item is the
answer only when nothing was taken back, held or left. Restore and Discard write no live file, so
they judge the branch's owner only. A file in the project (no Work, no lineage) has no closed owner.

The file policy's own owner reader (`loadPhysicalOwnership`, `file-policy/adapters/drizzle-file-facts.ts`)
stays separate: a grant is about a document's content where it stands now, live's placement
first, while a tree command's owners come from where its records put things. Sharing it would
bring back the miss of move destinations and folders.

**The day-30 purge** (`recovery.purgeDiscards`, `adapters/drizzle-discard-purge.ts`, run hourly
beside `purgeWorks` and `purgeDocuments`) is the only reader of the clock for Trash's command
entries. For each due command row of the three entry kinds it takes the Work lock with no
`requireActive` (an archived or deleted Work's entries expire too) and deletes the row, which
cascades its effects. That is a prefix of Restore's order. A Restore takes the same Work
lock, so it sees all of an entry or none. The tree's `purgeUnviewed` purges a drafted create (and
its draft and content) on its own clock, so the sweep leaves those drafts alone; the tree's
`discarded` records stay. A row whose branch is gone (a Work purge cascades the branch and its
drafts, not `commands`) is deleted with nothing to lock. A resend of a purged command id runs
again. Trash's listing has no clock: it lists whatever still exists, which is what restores. The browser rejoining a restored draft's room is the
client's.

[frozen]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/apply.md#the-click-owns-its-meaning
[later]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/apply.md#when-draft-and-live-both-changed-the-later-action-wins
