# The tree list store

This page says what the code decided about the list and what a change to it must keep.

The list (`@meridian/project-tree`: `ops` and `settle` lists in one Loro document per project,
and per account for `user://`) is stored as one `document_snapshots` row, room key
`tree:<list id>` and doc key `s`, rewritten whole by every change. The **list id** is the
`tree_list_id` of its project, or of its account, a column of its own made with the owner, never
the owner's id and never a node's or a document's. The list's `tree_lists` row (made with the owner by
trigger) is only the identity `tree_node_ids` hangs from by foreign key, so a list's nodes go with
its owner. A trigger
deletes the snapshot row with its project or account.

## One function

`createDrizzleTreeListStore({ db })` (`adapters/drizzle-tree-list-store.ts`) has these entries.
`admit` (a client's Loro update for a connection) and `submit` (records the server made, joining the
caller's transaction) change lists over one transaction skeleton (`withLists`); `read` and `resync`
are the other two:

- `submit({ lists, make })` works on one list or several. The keys of all of them are taken in
  list-id order whatever order the caller names them, so no path on the same lists deadlocks with
  another (Discard spans a project's list and the account's; retention takes both; a card's Undo
  of a reply that touched both). `make` is synchronous and gets a writer per list;
  it returns what the caller reads back. The store derives what was made from the copy's own
  change: the new nodes are the creates in the tail of the records that no earlier create names
  (a copy of a create, as Apply's live copy of a drafted one, claims nothing), and a state that
  changed without a record (a settlement) is stored too. A `make` that throws, `TreeRefusal` or
  anything else, stores nothing and the copies reload: refuse after reading, not after half
  making.
- `read({ lists, view })` reads the replays as stored, with no key and no Work lock. A
  copy this process changed and has not committed is never read: the list is loaded afresh. A
  `make` and a `view` are synchronous, so a copy is never seen half changed.
- `resync(lists)` brings the rows to the list's replay when something the rows read changed outside
  the list: a draft ended (a Work purged). It takes no key: it throws unless the transaction
  already holds the list's key. A draft opening changes no row:
  the document must show in the Work's view for the draft to open.

Work rows and lifecycle locks (`lockSeamWorks`) come first, then the list's advisory lock
(`lockDocumentMutation` on the list id), in this order:

1. bring this process's copy to the stored list: when the row's frontiers name ops the copy
   lacks (another process wrote), the copy imports the stored snapshot;
2. for `admit`: read `Connection` (`tree-list-facts.ts`: the open drafts and the list’s sources, including closed Works; a source with no row is gone) and run the package's `admit`: the update is imported as sent (bytes
   that are no Loro update throw, and nothing is stored), then each record that changes a closed Work (a create, rename, move, delete or restore in its draft
   or its Scratch) is stamped `dropped` ("Work was closed"). Nothing else is judged: a name, a
   type, a place or an actor is never refused;
3. claim the node ids the admitted creates name, each on its own (`claimNodeIds` returns the refused ones): one insert
   into `tree_node_ids`, whose key is the claim. An id that is not a uuid, or that a document,
   a list or another list's node has, is a failed claim: no row, no claim, and the rest of
   the update commits. A `dropped` record makes no claim or row change either. `syncRows` also drops
   from the rows any node the list holds no claim on (`dropUnowned`) and any node under a
   source that is not the list's project's, so a forged id can't overwrite another's row;
4. write the copy's snapshot to the list's row and `pg_notify('tree_list_advanced', <list id>)`;
5. `syncRows` (`tree-list-rows.ts`): replay live and every kept Work (a draft that has not
   ended: open, archived, or deleted and restorable) with pending tree records or pending text, then the `documents` rows of created documents from the
   replay's rows, compare with the rows last written, write the rows that differ, the
   previous locations and `location_version`. "Kept" is `keptDrafts` and "open" is
   `openDrafts` (`tree-list-facts.ts`): only open Works may write, but every kept Work's view is
   kept, so retention and "living" never lose a Work that can come back;
6. after the outermost commit, `onCommitted` listeners get the update (the list's room is one).

`submit` and `resync` join the caller's transaction, so a caller must hold no document or namespace
key it did not already hold with the list's (the list's key sorts before them; see the lock order
in `collab/.context/CONTEXT.md`); a path that needs a list and documents submits first. A purge asks
what holds a document (`tree/retention-holds.ts`) after a `submit` that only reads under the key and
before the one that purges, because a purge removes the rows the question reads.

Test hook points `treeList.*` mark each step; the kill suite stops a real process at each.

## Things a change must keep

- **The copy is changed in place, and set aside if its transaction did not commit.** `pending`
  names the transaction that changed it; another transaction finding it set loads the list again.
  Never read a copy outside the lock. A copy is a `LoroDoc`, which GC never frees: a copy set
  aside is freed once no transaction that took it and no `read` between its awaits holds it
  (`hold`/`release`).
- **Each copy writes under its own fresh server peer id** (`freshServerPeerId`, below
  `SERVER_PEER_LIMIT`), so no two copies, in one process or two, write under one peer: Loro
  throws on an update that names a doc's own peer at its next counter. Clients write above it.
- **A node id belongs to the list that claimed it, for good** (`tree_node_ids`). A row's
  `(id, list_id)` references the claim, and the upsert never writes `list_id`, so no write
  moves a node between lists, and nothing does: between a project's list and the account's the
  action is Copy, which makes new nodes.
- **The delete in force is part of a row.** The comparison includes the trash record; a new
  delete in force gets a new `trashed_at`. A node's location version bumps on any change to
  its address, its source included, and so do its descendants'.
- **A purged node has no row.** `tree_nodes.parent_id` is a composite foreign key with
  `context_source_id`, deferred to the commit: a node's folder is in its own source, and a
  folder purged while a child's row stands fails the transaction. Purge a subtree in one
  submission.
- **Every document create states its type** (the package requires it), so a document's row
  has one and no default is filled in here.
- **A client create's node id is claimed per create, and a failed claim is no refusal.** The node
  stays in the list (its writer sees it, a ghost that opens nothing) and has no row; the server's
  own creates (`submit`) use the same claim but refuse all-or-nothing: any refused id throws
  `NodeIdRefusedError` and rolls them back.
- **A trashed row's `trash_record` is the first delete in force that took it; `trashed_at` is
  when the server admitted it,** not when the record's author made it.
- **The `documents` row of a created document is inserted by the admission** from the
  replay's row (its source and name as the tree shows them, not the record's), with the
  columns `documents` still has for placement. Step 4 narrows `documents`; the insert in
  `insertDocumentRows` narrows with it.
- **The whole list is written on every change.** The snapshot grows with the list and every change
  rewrites it whole; the projects measured are far smaller than the size where that rewrite would
  dominate. If a list's row grows that big, save its changes on the document rooms' debounce
  instead, not per command.

## Reading a Work's tree in SQL

The measurement behind the one-table shape (22,110 nodes, three Works with about 200 rows each,
median of 21 runs, a three-folder path walk): live 0.18 ms; a Work's view as a plain left join
with `COALESCE` 7.5 ms (72 ms when the walk is written to force index use); as the
index-friendly union (`tree_nodes` rows with no `draft_tree_nodes` row for the draft, then
the draft's rows) with each walk step a `LATERAL (... OFFSET 0)` subquery, 0.48 ms. Today's
two-table shape in the same walk costs 3.1 ms. A recursive step that joins the relation without
the `LATERAL` is planned as a hash join of the whole relation, whatever the form: write
readers' walks with the `LATERAL`.

## The list's room

`lib/loro-tree-rooms.ts`, joined on `/ws/loro` beside the document rooms (`lib/loro-ws-handler.ts`,
room `tree:project:<id>` or `tree:account:<id>`), in the same envelope and room version as a
document's room, with the one doc key `s`. `open` names the list id (null unless the project or
account is the signed-in account's); `JoinResponseOk.extra` carries it (`list`), so a client whose
stored copy is of another list drops it and joins again with no version. `sync` sends the stored
list past the client's version.

What a change must keep:

- **The room's sockets hear only what the store committed.** A client's batch goes to `admit` as
  sent and is acked after the commit; what reaches the sockets, the sender's included, is the
  stored list past what the room last sent, read after `onListAdvanced`. The `NOTIFY` each commit
  sends reaches every process (this one too), so one path serves a process's own commits and
  another's. `listen()` on the store starts hearing it (`app.ts`).
- **No content check and no rate limit.** Bytes that are no Loro update end the room
  (`CORRUPT_UPDATE`); anything Loro imports is stored, and the replay reads the list as it
  stands.
