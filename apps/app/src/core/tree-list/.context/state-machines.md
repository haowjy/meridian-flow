# Tree list state machines

## List connection

A tab's view of one list's connection (`TreeListStatus` in `tree-list-session.ts`, from
`ListSyncState` in `@meridian/tree-list-sync`). The tab that owns the connection computes it;
the others show what it announces over the channel. It has the shape of
[a connection that replays](../../../../../../.context/state-machines/connection-that-replays.md)
with Yjs's sync in place of a replay: reconnecting brings the copy and the server level, and
nothing is replayed.

```mermaid
stateDiagram-v2
  [*] --> waiting: the session opens
  waiting --> synced: the server's list has arrived and ours has gone
  synced --> offline: the connection drops
  offline --> synced: it reconnects and levels
  synced --> rebuilding: the server refused the copy whole (list-rebuild)
  offline --> rebuilding: the same, on reconnecting
  rebuilding --> synced: the rebuilt copy has the server's list and our records again
  waiting --> denied: no access to the list
  synced --> denied: no access
  denied --> [*]
```

- `waiting` lasts until the first sync of this session, however much the stored copy holds: a
  copy that has not caught up is not proof that a node is absent.
- `rebuilding` throws the copy away: the snapshot's `doc` becomes a new document under a new Yjs
  client id. The records the old copy held that the server had not admitted are appended again.
- A close that is not a refusal (a drop, a server restart) is `offline`, and the provider's own
  reconnect does the rest. `denied` is final.

## Connection owner

Which tab holds the connection: `follower` until the tab holds the list's Web Lock, then `owner`
for as long as the tab lives. Followers queue on the lock, so when the owner's tab closes the
next one takes over with the copy it already has.
