# The tree list store

Design: `work/project-tree-design/design.md` sections 3 and 4 (docs repository). This page says
what the code decided and what a change to it must keep.

The list (`@meridian/project-tree`: `ops` and `settle` arrays in one Yjs document per project,
and per account for `user://`) is stored in the document journal under the **list id**: the `tree_list_id` of its project,
or of its account, a column of its own made with the owner, never the owner's id and never a
node's or a document's. `document_yjs_heads` keys the journal; the head is made with the owner
by trigger, is of kind `tree_list`, and names its owner, so no `documents` row exists for it
and no reader of `documents` meets one.

## One function

`createDrizzleTreeListStore({ db, journal })` (`adapters/drizzle-tree-list-store.ts`) has two
entry points over one transaction skeleton (`withList`): `admit` (a client's Yjs update for a
connection) and `submit` (records the server made, which joins the caller's transaction).

Work rows and lifecycle locks (`lockSeamWorks`) come first, then the list's advisory lock
(`lockDocumentMutation` on the list id), in this order:

1. bring this process's copy to the journal's head: a copy that is the journal's, or behind it
   with every row it lacks still in the journal, reads only the rows after it; a copy behind
   the head's `retired_through_seq` (rows folded into a checkpoint) is reloaded from the
   checkpoint;
2. for `admit`: read `Connection` (`tree-list-facts.ts`) and run the package's `admit`, which
   checks the update, applies it to the copy and appends the verdicts. A refusal stores
   nothing and returns `ok: false`;
3. claim the node ids the admitted records create (`claimNodeIds`): one insert into
   `tree_node_ids`, whose key is the claim. A conflict, or an id a document or a list's
   journal has, rolls the whole transaction back and `admit` returns `ok: false`;
4. append what the copy gained to the journal through its system path (`origin: "system"`;
   a person's path would read the whole list to record an edit);
5. `syncRows` (`tree-list-rows.ts`): replay live and every open Work with pending tree
   records or pending text, then the `documents` rows of created documents from the
   replay's rows, compare with the rows last written, write the rows that differ, the
   previous locations and `location_version`. "Open Work" is `openBranches`
   (`tree-list-facts.ts`), the one predicate for both a write's check and the views;
6. after the outermost commit, `onCommitted` listeners get the update (the list's room is one).

`submit` joins the caller's transaction, so a caller must hold no document or namespace key
when it calls (the list's key sorts before them; see the lock order in
`collab/.context/CONTEXT.md`); a path that needs a list and documents submits first or takes the
list's key itself before theirs.

Test hook points `treeList.*` mark each step; the kill suite stops a real process at each.

## Things a change must keep

- **The copy is changed in place, and thrown away if its transaction did not commit.** `pending`
  names the transaction that changed it; another transaction finding it set reloads. Never
  read a copy outside the lock.
- **Every server record, in every list and process, is made under Yjs client id 1.** Clients
  may not use ids below 1,000 (the package's check). Every server write is made under the
  list's lock on a copy at the journal's head, so two copies never make an item at once. A
  copy applies journal rows under client id 2 (`applyHistory`), because Yjs gives a copy a
  random id of 1,000 or more when an applied update advances its own client's clock, and
  an applying transaction is never local, so wrapping the apply in `transact` does not help.
- **A node id belongs to the list that claimed it, for good** (`tree_node_ids`). A row's
  `(id, list_id)` references the claim, and the upsert never writes `list_id`, so no write
  moves a node between lists. Only the server's own move of a node to the other list would
  move its claim, and none is built.
- **The delete in force is part of a row.** The comparison includes the trash record; a new
  delete in force gets a new `trashed_at`. A node's location version bumps on any change to
  its address, its source included, and so do its descendants'.
- **A purged node has no row.** `tree_nodes.parent_id` is a composite foreign key with
  `context_source_id`, deferred to the commit: a node's folder is in its own source, and a
  folder purged while a child's row stands fails the transaction. Purge a subtree in one
  submission.
- **Every document create states its type** (the package requires it), so a document's row
  has one and no default is filled in here.
- **Admission claims every create's node id, a refused one included.** The package's
  `takenElsewhere` answers false because the database is asked after `admit`, in the
  admitting transaction (`claimNodeIds`); a taken id rolls the whole update back. A refused
  create's kept create reuses its node, so the records claim it once.
- **A trashed row's `trash_record` is the first delete in force that took it; `trashed_at` is
  when the server admitted it,** not when the record's author made it.
- **The `documents` row of a created document is inserted by the admission** from the
  replay's row (its source and name as the tree shows them, not the record's), with the
  columns `documents` still has for placement. Step 4 narrows `documents`; the insert in
  `insertDocumentRows` narrows with it.

## Reading a Work's tree in SQL

The measurement behind the one-table shape (22,110 nodes, three Works with about 200 rows each,
median of 21 runs, a three-folder path walk): live 0.18 ms; a Work's view as a plain left join
with `COALESCE` 7.5 ms (72 ms when the walk is written to force index use); as the
index-friendly union (`tree_nodes` rows with no `branch_tree_nodes` row for the branch, then
the branch's rows) with each walk step a `LATERAL (... OFFSET 0)` subquery, 0.48 ms. Today's
two-table shape in the same walk costs 3.1 ms. A recursive step that joins the relation without
the `LATERAL` is planned as a hash join of the whole relation, whatever the form: write
readers' walks with the `LATERAL`.

## The list's room

`lib/yjs-tree-room.ts`, mounted in `lib/yjs-ws-handler.ts` beside the document rooms (same
gateway, same Hocuspocus, hooks branch on the room's kind). `open` names the access (the
project's owner: `edit` when the account can write a source, else `read`) and the journal id;
`readSince` gives the room its state, and each catch-up the rows past the room's `seq`. The
protocol and the machine are in `lib/.context/state-machines.md`, "Tree list room connection".

What a change must keep:

- **The room's document is never written by a client's frame.** `beforeSync` admits through the
  store first, and a refusal throws before Hocuspocus applies anything; what reaches the
  document is `onCommitted`'s update, so a refused update is in no copy.
- **`seq` is a journal row id, global across lists**, so a room cannot tell a gap from the next
  row. A commit applies its update to the process's own room at once; the `NOTIFY` it sent in
  its transaction then reaches every process (this one too), whose room reads the rows past
  `seq`. `listen()` on the store starts hearing it (`app.ts`); the catalog this list replaces
  gave every tab cross-process freshness, so the tree must too. Measured across two processes
  in the room's test: about 20 ms from a tab's record to an idle tab on the other.
- **Nothing is cut on the way to a browser.** Only the client's sends are split in parts.

