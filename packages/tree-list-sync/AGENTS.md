# @meridian/tree-list-sync

How a client keeps its copy of a project's tree list the server's, over the Yjs socket. Used by
the browser (`apps/app/src/core/tree-list`) and by the server's room tests.

- `connectTreeList` owns the provider and the socket and nothing else: the copy, its storage and
  its tabs come in through `ListCopy`.
- Whatever crosses the socket in either direction goes in parts of `PART_RECORDS` records
  (`splitSyncFrame`), so no honest client meets the server's cap of 2,000 records on one update.
  The server cuts what it sends with the same function. A limit an honest client can reach
  is never a whole refusal.
- A close with `list-rebuild` means the server refused the copy whole: the copy is replaced,
  the new one syncs under a new Yjs client id, and the records it lacks are appended again, each
  in a transaction of its own. A record refused again and again is dropped (`onRejected`), never
  looped on.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md).
