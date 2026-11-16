# @meridian/project-tree

The project tree as an append-only list of records in a Yjs document, replayed into a tree.
The server and the browser both use it. It owns no database, access rules, routes or storage:
what only the server knows (which account a connection is, which Works are open, which sources
it may write, whether a node id is in use) comes in as plain inputs.

- A record is one act by one actor. The list never deletes, and nothing here edits a record:
  a record's state is its last settlement in the `settle` array, never a field on it.
- Replay is a pure function of the records. It never changes what Yjs merged; the fourteen rules
  in [.context/CONTEXT.md](.context/CONTEXT.md) are the only place the product decides
  anything, each beside the Yjs default it replaces. A fifteenth rule goes there, in `replay.ts`,
  and in a casebook test that fails without it.
- Two siblings may share a name (rule 14): a node's `name` is its label, and the later twin's
  path segment adds `~` and its `suffix` (`segmentOf`). A reader that spells or walks a path
  uses the segment (`childAtSegment`, in `@meridian/contracts/protocol`); one that shows a title uses the name.
- A client may write five record kinds with its own account as the actor. Everything else
  (copies, which carry `carries`; files, `purge`, settlements) is the server's, and `guard`
  closes a copy whose update carries it (`CopyFault`): nothing else is refused. `clientMayWrite`
  is the same test on one record, for a client that appends records it carried over. A record
  the reader cannot read, or the replay cannot place, is skipped the same way in every replay.
  Nothing reads a decoded record's fields directly: `replay`, `listRecords` and the list index
  read through `readStored`.
- No name is refused. The replay and the writer store and show `normalEntryName(kind, typed)`
  (contracts) for every create and rename name. **Frozen as the replay uses it:** the list
  keeps what was typed and every client replays it through that function, so a change to what it
  returns for an input needs a migration of the list. **Frozen the same way:** `classifyFiletype`
  and `schemaType` as rules 11 and 12 read them (a document of an untracked type, or a rename
  across Yjs schemas, is skipped), and the cross-schema rule.
- Record ids are uuids, so any number of writers may share a copy. The server's Yjs client id is
  below 1,000.
- What a document is (type, provisional name, aliases, properties mark) rides on its `create`
  and `rename`. Which types a client may state, and whether a type change stays in one Yjs
  schema, are the server's facts: they come in through `Connection`.
- A Discard is final: `restoreDiscard` appends new pending copies on the branch it is given (`carries` names the original, `restores` the Discard,
  `restoredBy` who restored it); the discarded records stay discarded.
- Every record the package writes goes through `writable`, the reader that will read it back, and
  throws if that would drop it. A document's `create` states its `filetype`.
- Who a delete covers is `deleteCovering` (rows, Trash, the tools), and a document's item in a
  view is `recordsOfItem` (Apply, Discard, review attribution). A delete's recorded `cascade` is
  what its author saw: nothing reads it as what the delete covers now.
- Nothing moves between two lists: between a project's list and the account's the server
  copies (new nodes), so no record names another list.

Design and the evidence behind each rule: [.context/CONTEXT.md](.context/CONTEXT.md).
