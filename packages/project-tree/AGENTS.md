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
  `readRecord` refuses a client's update that carries it. Nothing reads a decoded record's
  fields directly: `replay`, `listRecords` and the list index read through `readStored`.
- Record ids are uuids, so any number of writers may share a copy. The server's Yjs client id is
  below 1,000.
- What a document is (type, provisional name, aliases, properties mark) rides on its `create`
  and `rename`. Which types a client may state, and whether a type change stays in one Yjs
  schema, are the server's facts: they come in through `Connection`.
- A Discard is final: `restoreDiscard` appends new pending copies (`restores` names the Discard,
  `restoredBy` who restored it); the discarded records stay discarded.
- Every record the package writes goes through `writable`, the reader that will read it back, and
  throws if that would drop it. A document's `create` states its `filetype`.
- A move between two lists is `moveBetweenLists`: a `move` to `list:<id>` in one list and a
  `create` in the other. Only the server writes it.

Design and the evidence behind each rule: [.context/CONTEXT.md](.context/CONTEXT.md).
