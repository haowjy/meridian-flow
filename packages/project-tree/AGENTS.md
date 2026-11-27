# @meridian/project-tree

The project tree as an append-only list of records in a Loro document, replayed into a tree.
The server and the browser both use it. It owns no database, access rules, routes or storage:
what only the server knows (which account a connection is, which Works are open, which sources
it may write, whether a node id is in use) comes in as plain inputs.

- A record is one act by one actor. The list never deletes, and nothing here edits a record:
  a record's state is its last settlement in the `settle` array, never a field on it.
  An actor is built only by `userActor`, `agentActor` or `SYSTEM_ACTOR` and read only by
  `readActor` (`record.ts`). Its spelling is stored and replay reads it (a user's rename ends
  a node's provisional state), so it is frozen like the records.
- Replay is a pure function of the records. It never changes what Loro merged; the fifteen rules
  in [.context/CONTEXT.md](.context/CONTEXT.md) are the only place the product decides
  anything, each beside the CRDT default it replaces. A sixteenth rule goes there, in `replay.ts`,
  and in a casebook test that fails without it.
- Two siblings may share a name (rule 14): a node's `name` is its label, and the later twin's
  path segment adds `~` and its `suffix` (`segmentOf`). A reader that spells or walks a path
  uses the segment (`childAtSegment`, in `@meridian/contracts/protocol`); one that shows a title uses the name.
- A client may write five record kinds with its own account as the actor. Everything else
  (copies, which carry `carries`; files, `purge`, settlements) is the server's. Nothing is
  refused: the server imports a client's update as sent (`admit`). A record
  the reader cannot read, or the replay cannot place, is skipped the same way in every replay.
  Nothing reads a decoded record's fields directly: `replay`, `listRecords` and the list index
  read through `readStored`.
- No name is refused. The replay and the writer store and show `normalEntryName(kind, typed)`
  (contracts) for every create and rename name. **Frozen as the replay uses it:** the list
  keeps what was typed and every client replays it through that function, so a change to what it
  returns for an input needs a migration of the list. **Frozen the same way:** `classifyFiletype`
  and `schemaType` as rules 11 and 12 read them (a document of an untracked type, or a rename
  across document schemas, is skipped), and the cross-schema rule.
- Record ids are uuids, so any number of writers may share a copy. Each server copy takes a fresh
  server peer id (`freshServerPeerId`, below `SERVER_PEER_LIMIT`).
- What a document is (type, provisional name, aliases, properties mark) rides on its `create`
  and `rename`. Which types a client may state, and whether a type change stays in one document
  schema, are the server's facts: they come in through `Connection`.
- A Discard is final: `restoreDiscard` appends new pending copies on the draft it is given (`carries` names the original, `restores` the Discard,
  `restoredBy` who restored it); the discarded records stay discarded. A Discard with `trash`
  (the press's) puts the nodes the Work created in live's Trash, by live creates that carry the
  drafted ones, and returns the deletes, which the caller records; `restoreDiscard` given them
  takes back each delete still in force and the create under it with a withdrawal, so the nodes
  are the Work's pending creates again and in no live view (rule 15). What Trash's Restore lifted
  first stays in live, with the folders above it. Only the press's Undo writes withdrawals.
- Every record the package writes goes through `writable`, the reader that will read it back, and
  throws if that would drop it. A document's `create` states its `filetype`.
- Who a delete covers is `deleteCovering` (rows, Trash, the tools), and a document's item in a
  view is `recordsOfItem` (Apply, Discard, review attribution). A delete's recorded `cascade` is
  what its author saw: nothing reads it as what the delete covers now.
- Nothing moves between two lists: between a project's list and the account's the server
  copies (new nodes), so no record names another list.

Design and the evidence behind each rule: [.context/CONTEXT.md](.context/CONTEXT.md).
