# The tree list store

Design: `work/project-tree-design/design.md` sections 3 and 4 (docs repository). This page says
what the code decided and what a change to it must keep.

The list (`@meridian/project-tree`: `ops` and `settle` arrays in one Yjs document per project,
and per account for `user://`) is stored in the document journal under the **list id**: the
project's id, or the account's. `document_yjs_heads` keys the journal; a list's head names its
owner, so no `documents` row exists for it and no reader of `documents` meets one.

## One function

`createDrizzleTreeListStore({ db, journal })` (`adapters/drizzle-tree-list-store.ts`) has two
entry points over one transaction skeleton (`withList`): `admit` (a client's Yjs update for a
connection) and `submit` (records the server made, which joins the caller's transaction).

Under the list's advisory lock (`lockDocumentMutation` on the list id), in this order:

1. make the head if there is none; bring this process's copy to the journal's head (reload
   from the journal if the copy is not at it, else read only the rows after it);
2. for `admit`: read `Connection` (`tree-list-facts.ts`) and run the package's `admit`, which
   checks the update, applies it to the copy and appends the verdicts. A refusal stores
   nothing and returns `ok: false`;
3. append what the copy gained to the journal through its system path (`origin: "system"`;
   a person's path would read the whole list to record an edit);
4. `syncRows` (`tree-list-rows.ts`): `documents` rows for created documents, then replay of
   live and of each open Work with pending records, compare with the rows last written, write
   the rows that differ, the previous locations and `location_version`;
5. after the outermost commit, `onCommitted` listeners get the update (the room, step 5 of the
   build, is one).

Test hook points `treeList.*` mark each step; the kill suite stops a real process at each.

## Things a change must keep

- **The copy is changed in place, and thrown away if its transaction did not commit.** `pending`
  names the transaction that changed it; another transaction finding it set reloads. Never
  read a copy outside the lock.
- **Server records are made under one Yjs client id per process and list, below 1,000**, from
  the `tree_server_client_id` sequence, set after the history is applied. Clients may not use
  ids below 1,000 (the package's check).
- **A node's row belongs to the list that wrote it** (`list_id`). Comparison and deletes are
  scoped by it, so a node that moves to the other list is rewritten by that list's admission
  and the first list's delete of it does not touch it.
- **A purged node has no row.** `tree_nodes.parent_id` is a composite foreign key with
  `context_source_id`, deferred to the commit: a node's folder is in its own source, and a
  folder purged while a child's row stands fails the transaction. Purge a subtree in one
  submission.
- **A document made with no type gets the default one** (`DEFAULT_FILETYPE`) in `shownRows`,
  once, so every comparison and row agrees.
- **A trashed row's `trash_record` is the first delete in force that took it; `trashed_at` is
  when the server admitted it,** not when the record's author made it.
- **The `documents` row of a created document is inserted by the admission** with the columns
  `documents` still has for placement. Step 4 narrows `documents`; the insert in
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
