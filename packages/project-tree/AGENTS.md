# @meridian/project-tree

The project tree as an append-only list of records in a Yjs document, replayed into a tree.
The server and the browser both use it. It owns no database, access rules, routes or storage:
what only the server knows (which account a connection is, which Works are open, which sources
it may write, whether a node id is in use) comes in as plain inputs.

- A record is one act by one actor. The list never deletes, and nothing here edits a record:
  a record's state is its last settlement in the `settle` array, never a field on it.
- Replay is a pure function of the records. It never changes what Yjs merged; the eight rules
  in [.context/CONTEXT.md](.context/CONTEXT.md) are the only place the product decides
  anything, each beside the Yjs default it replaces. A ninth rule goes there, in `replay.ts`,
  and in a casebook test that fails without it.
- A client may write five record kinds with its own account as the actor. Everything else
  (applied copies, files, `purge`, settlements, `replaces`) is the server's, and
  `malformedRecord` refuses a client's update that carries it.
- The server keeps one `TreeWriter` per copy of the list and one Yjs client id below 1,000.
  Ids from a fresh writer repeat the last one's.

Design and the evidence behind each rule: [.context/CONTEXT.md](.context/CONTEXT.md).
